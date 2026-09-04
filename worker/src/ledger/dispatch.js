import { BadRequest } from '../http.js';
import {
  validateEnvelope, requireQuantity, payloadHash, alreadyAccepted, eventRow, lookupRow,
} from './envelope.js';
import { toBaseUnit } from './units.js';
import { balanceAt, holdsOn } from './stock.js';
import { loadLimits, probeKindFor, withinLimit, requireReading } from './temperature.js';

// Dispatch: produced stock leaving for a customer.
//
// One submission is one delivery to one customer, carrying many product
// lines. Each line writes a DISPATCH movement — negative, in the lot's base
// unit, at the location the stock left from — so the outgoing balance and the
// one-step-back trace both come out of the ledger with no special case.
//
// What is NOT here matters as much as what is:
//
// - **No new use-by.** The produced lot already carries the use-by its recipe
//   rule derived at packing, and that is what is on the packet. Dispatch
//   reads it off the lot and passes it through; it never computes one.
//
// - **The temperature check is a gate, not a deviation.** Goods-in records a
//   warm delivery and holds the lot, because the stock has already arrived. A
//   dispatch has not happened yet, so a van that is too warm is a refusal at
//   the point of loading (Dean, 2026-09-04). The check is the vehicle's own
//   temperature, one reading per class the load carries — the question is
//   whether the transport is suitable, not the state of each packet, which
//   was settled at packing. A reading that passes is written as evidence the
//   check was made; a reading that fails stops the whole submission and
//   nothing is written.
//
// Like goods-in, every line is validated before anything is written, so a
// dispatch is recorded whole or not at all.

// A produced lot, with everything the checks below need in one read.
async function dispatchLine(db, line, where) {
  const lot = await lookupRow(
    db,
    `SELECT l.id, l.status, l.origin, l.use_by, l.use_by_source,
            l.item_id, i.name AS item_name, i.base_unit, i.kind, i.storage_unopened
       FROM lots l JOIN items i ON i.id = l.item_id WHERE l.id = ?`,
    line.lot_id,
  );
  if (!lot) throw new BadRequest(`${where}: unknown lot ${JSON.stringify(line.lot_id)}`);

  // Only stock the kitchen made leaves this way. A delivered ingredient that
  // is somehow being dispatched is either a picking mistake or a lot
  // confusion, and sending it would put the wrong genealogy in front of the
  // customer.
  if (lot.origin !== 'produced') {
    throw new BadRequest(
      `${where}: ${lot.item_name} came from a delivery, not a batch, so it cannot be dispatched`,
    );
  }

  if (lot.status !== 'open') {
    throw new BadRequest(`${where}: that lot of ${lot.item_name} is ${lot.status} and cannot be dispatched`);
  }
  const held = await holdsOn(db, lot.id);
  if (held.total) {
    throw new BadRequest(`${where}: that lot of ${lot.item_name} is held and cannot be dispatched`);
  }

  const location = await lookupRow(db, 'SELECT id, name, active FROM locations WHERE id = ?', line.location_id);
  if (!location) throw new BadRequest(`${where}: unknown location ${JSON.stringify(line.location_id)}`);
  if (location.active !== 1) throw new BadRequest(`${where}: ${location.name} is not an active location`);

  const quantity = requireQuantity(line.quantity, `${where}.quantity`);
  const unit = line.unit || lot.base_unit;
  const converted = await toBaseUnit(
    db,
    { id: lot.item_id, name: lot.item_name, base_unit: lot.base_unit },
    quantity,
    unit,
  );

  const available = await balanceAt(db, lot.id, location.id);
  if (converted.quantity > available) {
    throw new BadRequest(
      `${where}: only ${available} ${lot.base_unit} of ${lot.item_name} is in ${location.name}, ` +
        `and the dispatch asks for ${converted.quantity}. Count it again, or split the line.`,
    );
  }

  return {
    lot,
    location,
    quantity: converted.quantity,
    enteredQuantity: quantity,
    enteredUnit: unit,
    probeKind: probeKindFor(lot),
  };
}

export async function dispatch(db, payload) {
  const envelope = await validateEnvelope(db, payload, { requireDevice: false });
  const hash = await payloadHash(payload);
  const existing = await alreadyAccepted(db, envelope.idempotency_key, hash);
  if (existing) return { duplicate: true, ...(await dispatchResult(db, existing.id)) };

  const customer = await lookupRow(db, 'SELECT id, name, active FROM customers WHERE id = ?', payload.customer_id);
  if (!customer) throw new BadRequest(`unknown customer ${JSON.stringify(payload.customer_id)}`);
  if (customer.active !== 1) throw new BadRequest(`${customer.name} is not an active customer`);

  if (!['good', 'poor'].includes(payload.vehicle_condition)) {
    throw new BadRequest('vehicle_condition must be good or poor');
  }

  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new BadRequest('lines must be a non-empty array: a dispatch of nothing is not a dispatch');
  }

  const limits = await loadLimits(db);

  const lines = [];
  for (const [index, line] of payload.lines.entries()) {
    lines.push(await dispatchLine(db, line, `lines[${index}]`));
  }

  // The same lot from the same place twice in one dispatch is a slip that
  // would take it out twice over. Two lots of one product is ordinary.
  const keys = lines.map((row) => `${row.lot.id}@${row.location.id}`);
  if (new Set(keys).size !== keys.length) {
    throw new BadRequest('the same lot is listed twice from the same place: combine those lines');
  }

  // Vehicle readings, one per temperature class the load actually contains.
  // Asked for only where there is stock they are about, and a breach stops
  // the load rather than sending it warm.
  const readings = [];
  for (const [kind, field] of [['chilled', 'vehicle_chilled_c'], ['frozen', 'vehicle_frozen_c']]) {
    const needed = lines.some((row) => row.probeKind === kind);
    const value = payload[field];
    const given = value !== undefined && value !== null;
    if (needed && !given) {
      throw new BadRequest(`${field} is required: this dispatch contains ${kind} stock`);
    }
    if (!needed && given) {
      throw new BadRequest(`${field} was given but this dispatch contains no ${kind} stock`);
    }
    if (!given) continue;

    const celsius = requireReading(value, field);
    if (!withinLimit(celsius, limits[kind])) {
      throw new BadRequest(
        `the van's ${kind} temperature of ${celsius}°C is above the ${limits[kind]}°C limit; ` +
          'this load cannot go out on this vehicle',
      );
    }
    readings.push({
      id: `${envelope.event_id}-VEHICLE-${kind.toUpperCase()}`,
      lotId: null,
      kind: `vehicle_${kind}`,
      celsius,
      limitCelsius: limits[kind],
    });
  }

  const statements = [
    eventRow(db, envelope, 'dispatch', hash, payload),
    db
      .prepare(
        `INSERT INTO dispatches (event_id, customer_id, reference, vehicle_condition, vehicle_note, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        envelope.event_id,
        customer.id,
        payload.reference ?? null,
        payload.vehicle_condition,
        payload.vehicle_note ?? null,
        payload.note ?? null,
      ),
  ];

  for (const [index, line] of lines.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO movements (id, lot_id, type, quantity, entered_quantity, entered_unit,
                                  from_location_id, occurred_at, staff_id, event_id, note)
           VALUES (?, ?, 'DISPATCH', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${envelope.event_id}-DISPATCH-${index}`,
          line.lot.id,
          -line.quantity,
          line.enteredQuantity,
          line.enteredUnit,
          line.location.id,
          envelope.occurred_at,
          envelope.staff_id,
          envelope.event_id,
          payload.lines[index].note ?? null,
        ),
    );
  }

  for (const reading of readings) {
    statements.push(
      db
        .prepare(
          `INSERT INTO temperature_readings (id, event_id, lot_id, kind, celsius,
                                             limit_celsius, within_limit, staff_id, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          reading.id,
          envelope.event_id,
          reading.lotId,
          reading.kind,
          reading.celsius,
          reading.limitCelsius,
          envelope.staff_id,
          envelope.occurred_at,
        ),
    );
  }

  await db.batch(statements);
  return { duplicate: false, ...(await dispatchResult(db, envelope.event_id)) };
}

// What one dispatch sent, for a fresh submission and for the replay of one
// already accepted. Each line carries the use-by read straight off the
// produced lot — inherited, not recomputed.
export async function dispatchResult(db, eventId) {
  const [head, lines, readings] = await Promise.all([
    db
      .prepare(
        `SELECT d.event_id, d.customer_id, c.name AS customer_name, d.reference,
                d.vehicle_condition, d.vehicle_note, d.note, e.occurred_at, s.name AS dispatched_by
           FROM dispatches d
           JOIN customers c ON c.id = d.customer_id
           JOIN events e ON e.id = d.event_id
      LEFT JOIN staff s ON s.id = e.staff_id
          WHERE d.event_id = ?`,
      )
      .bind(eventId)
      .first(),
    db
      .prepare(
        `SELECT m.id, m.lot_id, -m.quantity AS quantity, m.entered_quantity, m.entered_unit,
                m.from_location_id, loc.name AS location_name,
                i.name AS item_name, i.base_unit, l.short_code, l.batch_code, l.use_by, l.use_by_source
           FROM movements m
           JOIN lots l ON l.id = m.lot_id
           JOIN items i ON i.id = l.item_id
      LEFT JOIN locations loc ON loc.id = m.from_location_id
          WHERE m.event_id = ? AND m.type = 'DISPATCH'
          ORDER BY i.name`,
      )
      .bind(eventId)
      .all(),
    db
      .prepare(
        `SELECT id, lot_id, kind, celsius, limit_celsius, within_limit
           FROM temperature_readings WHERE event_id = ? ORDER BY kind`,
      )
      .bind(eventId)
      .all(),
  ]);
  return {
    event_id: eventId,
    dispatch: head,
    lines: lines.results || [],
    readings: readings.results || [],
  };
}

// The recent dispatches, newest first. One row per submission with the
// customer, the line count and the total that left.
export async function recentDispatches(db, { customerId = null, limit = 50 } = {}) {
  const where = customerId ? 'WHERE d.customer_id = ?' : '';
  const params = customerId ? [customerId, limit] : [limit];
  const { results } = await db
    .prepare(
      `SELECT d.event_id, d.customer_id, c.name AS customer_name, d.reference,
              d.vehicle_condition, e.occurred_at, s.name AS dispatched_by,
              COUNT(m.id) AS line_count,
              COALESCE(SUM(-m.quantity), 0) AS total_quantity
         FROM dispatches d
         JOIN customers c ON c.id = d.customer_id
         JOIN events e ON e.id = d.event_id
    LEFT JOIN staff s ON s.id = e.staff_id
    LEFT JOIN movements m ON m.event_id = d.event_id AND m.type = 'DISPATCH'
        ${where}
     GROUP BY d.event_id
     ORDER BY e.occurred_at DESC
        LIMIT ?`,
    )
    .bind(...params)
    .all();
  return results || [];
}
