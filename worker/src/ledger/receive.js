import { BadRequest } from '../http.js';
import { toBaseUnit } from './units.js';
import { isCode } from './codes.js';
import { loadLimits, probeKindFor, withinLimit, requireReading, recheckDueAt } from './temperature.js';
import {
  requireUlid, requireTimestamp, requireDate, payloadHash, alreadyAccepted, eventRow, lookupRow,
} from './envelope.js';

// Goods intake. One submission books one delivery: it opens a lot per
// delivery line and writes the RECEIVE movement that puts that lot's quantity
// into a storage area.
//
// The structural change P1 makes is that recording the delivery and printing
// its labels become one act rather than two disconnected ones. That is why
// the short code arrives in the request: the device has already popped it
// from its pool and printed it, and this endpoint binds it to the lot the
// same submission creates. Nothing is joined by inference afterwards.
//
// A delivery also carries the checks that make it compliant rather than
// merely traceable — the vehicle's condition and temperatures, a probe
// reading per chilled or frozen line, and the attestations staff already make
// on paper. A reading outside its limit holds the lot it belongs to and opens
// a deviation, so the hold is something the system enforces rather than
// something a person is trusted to remember.
//
// Everything here refuses rather than assumes. An unknown item, a unit with
// no recorded conversion, a storage area that does not exist — each is a 400
// naming what is missing. A guess at intake is a wrong balance for the life
// of the lot and a wrong answer at the one moment this system exists for.

// The shelf-life fallback, applied only where the supplier printed no date
// (PLAN.md open question 5). Whole days from the day the delivery arrived.
export function deriveUseBy(occurredAt, shelfLifeDays) {
  const arrived = new Date(occurredAt);
  const useBy = new Date(Date.UTC(arrived.getUTCFullYear(), arrived.getUTCMonth(), arrived.getUTCDate()));
  useBy.setUTCDate(useBy.getUTCDate() + shelfLifeDays);
  return useBy.toISOString().slice(0, 10);
}

// Reads back what one submission wrote. Used both for a fresh submission and
// for the replay of one already accepted, so a device gets the same answer
// either way and never has to treat a duplicate differently.
export async function eventResult(db, eventId) {
  const [lots, movements] = await Promise.all([
    db
      .prepare(
        `SELECT l.id, l.item_id, i.name AS item_name, i.base_unit, l.short_code, l.batch_code,
                l.supplier_id, l.supplier_lot, l.supplier_invoice, l.originated_at,
                l.use_by, l.use_by_source, l.status
           FROM lots l JOIN items i ON i.id = l.item_id
          WHERE l.event_id = ? ORDER BY i.name`,
      )
      .bind(eventId)
      .all(),
    db
      .prepare(
        `SELECT id, lot_id, type, quantity, entered_quantity, entered_unit, to_location_id, occurred_at
           FROM movements WHERE event_id = ? ORDER BY id`,
      )
      .bind(eventId)
      .all(),
  ]);
  return { event_id: eventId, lots: lots.results || [], movements: movements.results || [] };
}

// Validates one delivery line against the catalog and works out everything
// the ledger needs. Reads only; the writing happens once every line has come
// through this, so a submission is accepted whole or not at all.
async function prepareLine(db, line, index, envelope, limits) {
  const where = `lines[${index}]`;
  const lotId = requireUlid(line.lot_id, `${where}.lot_id`);

  // A lot id is minted once, on the device, for one physical delivery line.
  // Seeing it again under a new idempotency key means a queued submission was
  // edited and resent rather than retried, and accepting it would book the
  // same cases twice. The earlier submission is named so the difference can
  // be looked at rather than guessed.
  const already = await lookupRow(db, 'SELECT id, event_id FROM lots WHERE id = ?', lotId);
  if (already) {
    throw new BadRequest(
      `${where}: lot ${lotId} already exists, booked by event ${already.event_id}. ` +
        'Retry the original submission with its own idempotency key, or mint a new lot.',
    );
  }

  // storage_unopened is what decides whether this line needs a probe reading,
  // so it has to come back with the row. Selecting only what was needed before
  // made every item look ambient and silently skipped every temperature check.
  const item = await lookupRow(
    db,
    'SELECT id, name, base_unit, shelf_life_days, storage_unopened, active FROM items WHERE id = ?',
    line.item_id,
  );
  if (!item) throw new BadRequest(`${where}: unknown item ${JSON.stringify(line.item_id)}`);
  if (item.active !== 1) throw new BadRequest(`${where}: ${item.name} is not an active item`);

  const location = await lookupRow(db, 'SELECT id, name, active FROM locations WHERE id = ?', line.location_id);
  if (!location) throw new BadRequest(`${where}: unknown location ${JSON.stringify(line.location_id)}`);
  if (location.active !== 1) throw new BadRequest(`${where}: ${location.name} is not an active location`);

  if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0) {
    throw new BadRequest(`${where}.quantity must be a positive number, got ${JSON.stringify(line.quantity)}`);
  }
  const unit = line.unit || item.base_unit;
  if (typeof unit !== 'string') throw new BadRequest(`${where}.unit must be a unit name`);
  const converted = await toBaseUnit(db, item, line.quantity, unit);

  // A date on the box wins. Where there is none the item's shelf life fills
  // in, and the lot records which of the two it was.
  let useBy = null;
  let useBySource = null;
  if (line.use_by !== undefined && line.use_by !== null) {
    useBy = requireDate(line.use_by, `${where}.use_by`);
    useBySource = line.use_by_source || 'supplier_printed';
    if (!['supplier_printed', 'shelf_life_rule'].includes(useBySource)) {
      throw new BadRequest(`${where}.use_by_source must be supplier_printed or shelf_life_rule`);
    }
  } else {
    useBy = deriveUseBy(envelope.occurred_at, item.shelf_life_days);
    useBySource = 'shelf_life_rule';
  }

  // The code was popped from this device's pool and is already on a printed
  // label, so it must be one this device holds and must not be bound to
  // another lot. Absent is allowed: a dry pool delays the label, not the lot.
  let shortCode = null;
  if (line.short_code !== undefined && line.short_code !== null) {
    if (!isCode(line.short_code)) {
      throw new BadRequest(`${where}.short_code is not a valid code: ${JSON.stringify(line.short_code)}`);
    }
    const held = await lookupRow(db, 'SELECT code, device_id, lot_id FROM short_codes WHERE code = ?', line.short_code);
    if (!held) throw new BadRequest(`${where}: short code ${line.short_code} was never issued`);
    if (held.device_id !== envelope.device_id) {
      throw new BadRequest(`${where}: short code ${line.short_code} belongs to another device`);
    }
    if (held.lot_id && held.lot_id !== lotId) {
      throw new BadRequest(`${where}: short code ${line.short_code} is already bound to lot ${held.lot_id}`);
    }
    shortCode = held.code;
  }

  // Chilled and frozen stock is probed; ambient stock is not. The catalog
  // already knows which an item is, so the form never has to ask and a line
  // that should carry a reading cannot quietly arrive without one.
  const probeKind = probeKindFor(item);
  let reading = null;
  if (probeKind) {
    if (line.product_temp_c === undefined || line.product_temp_c === null) {
      throw new BadRequest(
        `${where}: ${item.name} is kept in the ${probeKind === 'frozen' ? 'freezer' : 'fridge'}, ` +
          'so it needs a product temperature',
      );
    }
    const celsius = requireReading(line.product_temp_c, `${where}.product_temp_c`);
    const limitCelsius = limits[probeKind];
    reading = {
      id: `${lotId}-PRODUCT`,
      kind: 'product',
      celsius,
      limitCelsius,
      withinLimit: withinLimit(celsius, limitCelsius),
    };
  } else if (line.product_temp_c !== undefined && line.product_temp_c !== null) {
    throw new BadRequest(
      `${where}: ${item.name} is kept at ambient temperature, so a product reading would mean nothing`,
    );
  }

  return {
    lotId,
    item,
    shortCode,
    reading,
    batchCode: line.batch_code ?? null,
    supplierLot: line.supplier_lot ?? null,
    useBy,
    useBySource,
    note: line.note ?? null,
    locationId: location.id,
    quantity: converted.quantity,
    enteredQuantity: line.quantity,
    enteredUnit: unit,
    movementId: `${lotId}-RECEIVE`,
  };
}

async function validateEnvelope(db, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BadRequest('the body must be a JSON object');
  }
  const eventId = requireUlid(payload.event_id, 'event_id');
  if (typeof payload.idempotency_key !== 'string' || payload.idempotency_key.length < 8) {
    throw new BadRequest('idempotency_key must be a string of at least 8 characters, minted with the submission');
  }
  const occurredAt = requireTimestamp(payload.occurred_at, 'occurred_at');

  const staff = await lookupRow(db, 'SELECT id, name, active FROM staff WHERE id = ?', payload.staff_id);
  if (!staff) throw new BadRequest(`unknown staff ${JSON.stringify(payload.staff_id)}`);
  if (staff.active !== 1) throw new BadRequest(`${staff.name} is not active`);

  const device = await lookupRow(db, 'SELECT id, active FROM devices WHERE id = ?', payload.device_id);
  if (!device) throw new BadRequest(`unknown device ${JSON.stringify(payload.device_id)}`);
  if (device.active !== 1) throw new BadRequest(`device is not active: ${device.id}`);

  const supplier = await lookupRow(db, 'SELECT id, name, active FROM suppliers WHERE id = ?', payload.supplier_id);
  if (!supplier) throw new BadRequest(`unknown supplier ${JSON.stringify(payload.supplier_id)}`);
  if (supplier.active !== 1) throw new BadRequest(`${supplier.name} is not an active supplier`);

  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new BadRequest('lines must be a non-empty array: a delivery with no lines is not a delivery');
  }

  const checks = payload.checks;
  if (!checks || typeof checks !== 'object') {
    throw new BadRequest('checks are required: a delivery booked in without them is not a compliance record');
  }
  if (!['good', 'poor'].includes(checks.vehicle_condition)) {
    throw new BadRequest('checks.vehicle_condition must be good or poor');
  }
  for (const field of ['condition_ok', 'labels_applied', 'allergens_confirmed']) {
    if (typeof checks[field] !== 'boolean') {
      throw new BadRequest(`checks.${field} must be true or false — it is an attestation, not an optional tick`);
    }
  }

  return {
    event_id: eventId,
    idempotency_key: payload.idempotency_key,
    occurred_at: occurredAt,
    staff_id: staff.id,
    device_id: device.id,
    supplier_id: supplier.id,
    invoice: payload.invoice ?? null,
    checks: {
      vehicle_condition: payload.checks.vehicle_condition,
      vehicle_note: payload.checks.vehicle_note ?? null,
      condition_ok: payload.checks.condition_ok ? 1 : 0,
      labels_applied: payload.checks.labels_applied ? 1 : 0,
      allergens_confirmed: payload.checks.allergens_confirmed ? 1 : 0,
      note: payload.checks.note ?? null,
      vehicle_chilled_c: payload.checks.vehicle_chilled_c,
      vehicle_frozen_c: payload.checks.vehicle_frozen_c,
    },
  };
}

export async function receive(db, payload) {
  const envelope = await validateEnvelope(db, payload);
  const hash = await payloadHash(payload);

  // A submission that has already been accepted is answered with what it
  // wrote, not written again. This is the whole reason the key exists: the
  // device retries a queued submission until it hears back, and it must be
  // able to retry safely.
  const existing = await db
    .prepare('SELECT id, payload_hash FROM events WHERE idempotency_key = ?')
    .bind(envelope.idempotency_key)
    .first();
  if (existing) {
    if (existing.payload_hash !== hash) {
      throw new BadRequest(
        `idempotency key ${envelope.idempotency_key} was already used for a different submission. ` +
          'Keys are minted per submission and must never be reused.',
      );
    }
    return { duplicate: true, ...(await eventResult(db, existing.id)) };
  }

  const limits = await loadLimits(db);

  const lines = [];
  for (const [index, line] of payload.lines.entries()) {
    lines.push(await prepareLine(db, line, index, envelope, limits));
  }

  // The van's temperatures are asked for only where the delivery contains
  // stock they are about. A frozen reading on an all-ambient delivery is a
  // number with nothing to say, and its absence on a frozen delivery is a
  // missing check rather than a blank field.
  const vehicleReadings = [];
  for (const [kind, field, needed] of [
    ['chilled', 'vehicle_chilled_c', lines.some((line) => probeKindFor(line.item) === 'chilled')],
    ['frozen', 'vehicle_frozen_c', lines.some((line) => probeKindFor(line.item) === 'frozen')],
  ]) {
    const value = envelope.checks[field];
    const given = value !== undefined && value !== null;
    if (needed && !given) {
      throw new BadRequest(`checks.${field} is required: this delivery contains ${kind} stock`);
    }
    if (!needed && given) {
      throw new BadRequest(`checks.${field} was given but this delivery contains no ${kind} stock`);
    }
    if (!given) continue;

    const celsius = requireReading(value, `checks.${field}`);
    vehicleReadings.push({
      id: `${envelope.event_id}-VEHICLE-${kind.toUpperCase()}`,
      kind: `vehicle_${kind}`,
      celsius,
      limitCelsius: limits[kind],
      withinLimit: withinLimit(celsius, limits[kind]),
    });
  }

  const codes = lines.map((line) => line.shortCode).filter(Boolean);
  if (new Set(codes).size !== codes.length) {
    throw new BadRequest('two lines in this submission carry the same short code');
  }
  const lotIds = lines.map((line) => line.lotId);
  if (new Set(lotIds).size !== lotIds.length) {
    throw new BadRequest('two lines in this submission carry the same lot id');
  }

  const statements = [
    db
      .prepare(
        `INSERT INTO events (id, kind, idempotency_key, payload_hash, staff_id, device_id, occurred_at, payload)
         VALUES (?, 'receive', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        envelope.event_id,
        envelope.idempotency_key,
        hash,
        envelope.staff_id,
        envelope.device_id,
        envelope.occurred_at,
        JSON.stringify(payload),
      ),
  ];

  statements.push(
    db
      .prepare(
        `INSERT INTO delivery_checks (event_id, vehicle_condition, vehicle_note,
                                      condition_ok, labels_applied, allergens_confirmed, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        envelope.event_id,
        envelope.checks.vehicle_condition,
        envelope.checks.vehicle_note,
        envelope.checks.condition_ok,
        envelope.checks.labels_applied,
        envelope.checks.allergens_confirmed,
        envelope.checks.note,
      ),
  );

  // Every reading is kept, in limit or not. The in-limit ones are the evidence
  // that the check was made at all, which is the thing an auditor asks for.
  const readingRow = (reading, lotId) =>
    db
      .prepare(
        `INSERT INTO temperature_readings (id, event_id, lot_id, kind, celsius,
                                           limit_celsius, within_limit, staff_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        reading.id,
        envelope.event_id,
        lotId,
        reading.kind,
        reading.celsius,
        reading.limitCelsius,
        reading.withinLimit ? 1 : 0,
        envelope.staff_id,
        envelope.occurred_at,
      );

  // A breach opens a deviation with a recheck due, and holds the stock it is
  // about. A vehicle breach is about the whole load, so it holds every lot of
  // that temperature class in the delivery: if the van was warm, nothing that
  // came out of it is cleared by one good probe reading.
  const deviationRow = (reading, lotId) =>
    db
      .prepare(
        `INSERT INTO temperature_deviations (id, reading_id, lot_id, opened_at, recheck_due_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        `${reading.id}-DEV${lotId ? `-${lotId}` : ''}`,
        reading.id,
        lotId,
        envelope.occurred_at,
        recheckDueAt(envelope.occurred_at),
      );

  // Collected rather than appended, because a reading points at a lot and the
  // lots are written further down. Foreign keys are checked as each statement
  // runs, not at the end of the batch, so the order is not cosmetic.
  const afterLots = [];
  const held = new Set();

  for (const reading of vehicleReadings) {
    afterLots.push(readingRow(reading, null));
    if (reading.withinLimit) continue;
    const kind = reading.kind === 'vehicle_chilled' ? 'chilled' : 'frozen';
    for (const line of lines.filter((row) => probeKindFor(row.item) === kind)) {
      afterLots.push(deviationRow(reading, line.lotId));
      held.add(line.lotId);
    }
  }

  for (const line of lines) {
    if (!line.reading) continue;
    afterLots.push(readingRow(line.reading, line.lotId));
    if (line.reading.withinLimit) continue;
    afterLots.push(deviationRow(line.reading, line.lotId));
    held.add(line.lotId);
  }

  for (const line of lines) {
    statements.push(
      db
        .prepare(
          `INSERT INTO lots (id, item_id, short_code, batch_code, origin, supplier_id, supplier_lot,
                             supplier_invoice, originated_at, use_by, use_by_source, status, event_id, note)
           VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          line.lotId,
          line.item.id,
          line.shortCode,
          line.batchCode,
          envelope.supplier_id,
          line.supplierLot,
          envelope.invoice,
          envelope.occurred_at,
          line.useBy,
          line.useBySource,
          // Held rather than open, decided here rather than by a later update,
          // so a lot is never briefly usable between being written and being
          // held.
          held.has(line.lotId) ? 'held' : 'open',
          envelope.event_id,
          line.note,
        ),
    );

    // The code is bound only now, from the same transaction that creates the
    // lot, so a code can never be recorded as spent against a lot that was
    // never written.
    if (line.shortCode) {
      statements.push(
        db
          .prepare("UPDATE short_codes SET lot_id = ?, bound_at = datetime('now') WHERE code = ? AND lot_id IS NULL")
          .bind(line.lotId, line.shortCode),
      );
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO movements (id, lot_id, type, quantity, entered_quantity, entered_unit,
                                  to_location_id, occurred_at, staff_id, event_id)
           VALUES (?, ?, 'RECEIVE', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          line.movementId,
          line.lotId,
          line.quantity,
          line.enteredQuantity,
          line.enteredUnit,
          line.locationId,
          envelope.occurred_at,
          envelope.staff_id,
          envelope.event_id,
        ),
    );
  }

  statements.push(...afterLots);

  try {
    await db.batch(statements);
  } catch (err) {
    // Two copies of one submission can arrive at once from a device that
    // retried while the first was still in flight. The unique key is what
    // decides; the loser reads back what the winner wrote.
    const raced = await db
      .prepare('SELECT id, payload_hash FROM events WHERE idempotency_key = ?')
      .bind(envelope.idempotency_key)
      .first();
    if (raced && raced.payload_hash === hash) {
      return { duplicate: true, ...(await eventResult(db, raced.id)) };
    }
    throw err;
  }

  return { duplicate: false, ...(await eventResult(db, envelope.event_id)) };
}
