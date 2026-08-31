import { BadRequest } from '../http.js';
import {
  validateEnvelope, requireQuantity, payloadHash, alreadyAccepted, eventRow, lookupRow,
} from './envelope.js';

// Moving stock, throwing it away, and holding it.
//
// The rule underneath all three: a lot's balance at a location is the sum of
// its movements there, and it may never go below zero. Stock that is not
// there cannot be moved, wasted or consumed, and a system that allows it can
// no longer tell a mistake from a theft from a missing record.

// Stock on hand for one lot in one place, from the movements alone. Never
// read from a stored figure, because a stored figure can disagree with the
// events beneath it and this is the number everything else rests on.
export async function balanceAt(db, lotId, locationId) {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS quantity
         FROM movements
        WHERE lot_id = ? AND COALESCE(to_location_id, from_location_id) = ?`,
    )
    .bind(lotId, locationId)
    .first();
  return row.quantity;
}

// A lot is usable only when nothing at all is holding it — neither a
// temperature deviation nor a hold somebody opened by hand. Both are checked
// together so a lot can never be released by clearing one and forgetting the
// other.
export async function holdsOn(db, lotId) {
  const [temperature, manual] = await Promise.all([
    db
      .prepare('SELECT COUNT(*) AS n FROM temperature_deviations WHERE lot_id = ? AND outcome IS NULL')
      .bind(lotId)
      .first(),
    db.prepare('SELECT COUNT(*) AS n FROM holds WHERE lot_id = ? AND released_at IS NULL').bind(lotId).first(),
  ]);
  return { temperature: temperature.n, manual: manual.n, total: temperature.n + manual.n };
}

async function lot(db, lotId, where) {
  const row = await db
    .prepare(
      `SELECT l.id, l.status, l.short_code, i.name AS item_name, i.base_unit
         FROM lots l JOIN items i ON i.id = l.item_id
        WHERE l.id = ?`,
    )
    .bind(lotId)
    .first();
  if (!row) throw new BadRequest(`${where}: unknown lot ${JSON.stringify(lotId)}`);
  return row;
}

async function location(db, locationId, where) {
  const row = await lookupRow(db, 'SELECT id, name, active FROM locations WHERE id = ?', locationId);
  if (!row) throw new BadRequest(`${where}: unknown location ${JSON.stringify(locationId)}`);
  if (row.active !== 1) throw new BadRequest(`${where}: ${row.name} is not an active location`);
  return row;
}

// Stock is measured in the lot's base unit here, not in cases. By the time it
// is in the walk-in the case may be open, so a quantity keyed as "one case"
// would be a guess about how much is left in it.
async function takeFrom(db, lotRow, locationRow, quantity, what) {
  const available = await balanceAt(db, lotRow.id, locationRow.id);
  if (available <= 0) {
    throw new BadRequest(
      `there is no ${lotRow.item_name} from that lot in ${locationRow.name}, so none can be ${what}`,
    );
  }
  if (quantity > available) {
    throw new BadRequest(
      `only ${available} ${lotRow.base_unit} of ${lotRow.item_name} is in ${locationRow.name}, ` +
        `and ${quantity} cannot be ${what}. Count it again, or record the difference at the weekly count.`,
    );
  }
  return available;
}

// ------------------------------------------------------------------- move

export async function move(db, payload) {
  const envelope = await validateEnvelope(db, payload);
  const hash = await payloadHash(payload);
  const existing = await alreadyAccepted(db, envelope.idempotency_key, hash);
  if (existing) return { duplicate: true, ...(await moveResult(db, existing.id)) };

  const lotRow = await lot(db, payload.lot_id, 'lot_id');
  const from = await location(db, payload.from_location_id, 'from_location_id');
  const to = await location(db, payload.to_location_id, 'to_location_id');
  if (from.id === to.id) {
    throw new BadRequest('a move needs two different places: stock cannot be moved to where it already is');
  }

  const quantity = requireQuantity(payload.quantity, 'quantity');
  await takeFrom(db, lotRow, from, quantity, 'moved');

  // Held stock stays where it is. Moving it is how held stock quietly ends up
  // back in the usable racking.
  const holds = await holdsOn(db, lotRow.id);
  if (holds.total) {
    throw new BadRequest(
      `that lot of ${lotRow.item_name} is held and cannot be moved until the hold is closed`,
    );
  }

  // Two rows, one event: negative where it left and positive where it landed.
  // A single row with a from and a to could be half-applied by a later reader
  // that only looks at one of the columns; two rows cannot.
  await db.batch([
    eventRow(db, envelope, 'move', hash, payload),
    db
      .prepare(
        `INSERT INTO movements (id, lot_id, type, quantity, from_location_id, occurred_at, staff_id, event_id, note)
         VALUES (?, ?, 'MOVE', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(`${envelope.event_id}-OUT`, lotRow.id, -quantity, from.id, envelope.occurred_at, envelope.staff_id, envelope.event_id, payload.note ?? null),
    db
      .prepare(
        `INSERT INTO movements (id, lot_id, type, quantity, to_location_id, occurred_at, staff_id, event_id, note)
         VALUES (?, ?, 'MOVE', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(`${envelope.event_id}-IN`, lotRow.id, quantity, to.id, envelope.occurred_at, envelope.staff_id, envelope.event_id, payload.note ?? null),
  ]);

  return { duplicate: false, ...(await moveResult(db, envelope.event_id)) };
}

async function moveResult(db, eventId) {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.lot_id, m.type, m.quantity, m.from_location_id, m.to_location_id,
              i.name AS item_name, i.base_unit, m.waste_reason_id
         FROM movements m JOIN lots l ON l.id = m.lot_id JOIN items i ON i.id = l.item_id
        WHERE m.event_id = ? ORDER BY m.id`,
    )
    .bind(eventId)
    .all();
  return { event_id: eventId, movements: results || [] };
}

// ------------------------------------------------------------------ waste

export async function waste(db, payload) {
  const envelope = await validateEnvelope(db, payload);
  const hash = await payloadHash(payload);
  const existing = await alreadyAccepted(db, envelope.idempotency_key, hash);
  if (existing) return { duplicate: true, ...(await moveResult(db, existing.id)) };

  const lotRow = await lot(db, payload.lot_id, 'lot_id');
  const from = await location(db, payload.location_id, 'location_id');
  const quantity = requireQuantity(payload.quantity, 'quantity');
  await takeFrom(db, lotRow, from, quantity, 'thrown away');

  // Waste without a reason is just shrinkage with a timestamp. The vocabulary
  // is what makes "what do we throw away the most of, and why" answerable.
  const reason = await lookupRow(
    db,
    'SELECT id, name, staff_selectable FROM waste_reasons WHERE id = ?',
    payload.reason_id,
  );
  if (!reason) throw new BadRequest(`unknown waste reason ${JSON.stringify(payload.reason_id)}`);
  if (reason.staff_selectable !== 1) {
    throw new BadRequest(`"${reason.name}" is written by the system, not chosen`);
  }

  await db.batch([
    eventRow(db, envelope, 'waste', hash, payload),
    wasteRow(db, envelope.event_id, lotRow.id, quantity, from.id, reason.id, envelope, payload.note ?? null),
  ]);

  return { duplicate: false, ...(await moveResult(db, envelope.event_id)) };
}

// Shared with the temperature deviation that is closed as disposed, so stock
// thrown away for a failed reading leaves the balance the same way as stock
// thrown away by hand.
export function wasteRow(db, eventId, lotId, quantity, locationId, reasonId, envelope, note) {
  return db
    .prepare(
      `INSERT INTO movements (id, lot_id, type, quantity, from_location_id, occurred_at,
                              staff_id, event_id, waste_reason_id, note)
       VALUES (?, ?, 'WASTE', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      // The location is in the id because one disposal can empty the same lot
      // from more than one place, and those rows must not collide.
      `${eventId}-WASTE-${lotId}-${locationId}`,
      lotId,
      -quantity,
      locationId,
      envelope.occurred_at,
      envelope.staff_id,
      eventId,
      reasonId,
      note,
    );
}

// ------------------------------------------------------------------- hold

export async function hold(db, payload) {
  const envelope = await validateEnvelope(db, payload);
  const hash = await payloadHash(payload);
  const existing = await alreadyAccepted(db, envelope.idempotency_key, hash);
  if (existing) return { duplicate: true, event_id: existing.id };

  const lotRow = await lot(db, payload.lot_id, 'lot_id');
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (reason.length < 3) {
    throw new BadRequest('a hold needs a reason: somebody else has to know why this stock is not to be used');
  }

  await db.batch([
    eventRow(db, envelope, 'hold', hash, payload),
    db
      .prepare(
        `INSERT INTO holds (id, lot_id, reason, opened_at, opened_by, event_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(`${envelope.event_id}-HOLD`, lotRow.id, reason, envelope.occurred_at, envelope.staff_id, envelope.event_id),
    db
      .prepare("UPDATE lots SET status = 'held', updated_at = datetime('now') WHERE id = ? AND status = 'open'")
      .bind(lotRow.id),
  ]);

  return { duplicate: false, event_id: envelope.event_id, lot_id: lotRow.id, status: 'held' };
}

export async function releaseHold(db, payload) {
  const envelope = await validateEnvelope(db, payload, { requireDevice: false });

  const held = await db
    .prepare('SELECT id, lot_id, released_at FROM holds WHERE id = ?')
    .bind(payload.hold_id)
    .first();
  if (!held) throw new BadRequest(`unknown hold ${JSON.stringify(payload.hold_id)}`);
  if (held.released_at) throw new BadRequest('that hold was already released');

  const statements = [
    db
      .prepare(
        `UPDATE holds SET released_at = ?, released_by = ?, release_note = ?
          WHERE id = ? AND released_at IS NULL`,
      )
      .bind(envelope.occurred_at, envelope.staff_id, payload.note ?? null, held.id),
    // Only back to open when nothing else is holding it — a manual hold and a
    // temperature deviation on the same lot must both be closed.
    db
      .prepare(
        `UPDATE lots SET status = 'open', updated_at = datetime('now')
          WHERE id = ? AND status = 'held'
            AND NOT EXISTS (SELECT 1 FROM holds WHERE lot_id = lots.id AND released_at IS NULL AND id <> ?)
            AND NOT EXISTS (SELECT 1 FROM temperature_deviations WHERE lot_id = lots.id AND outcome IS NULL)`,
      )
      .bind(held.lot_id, held.id),
  ];
  await db.batch(statements);

  const row = await db.prepare('SELECT id, status FROM lots WHERE id = ?').bind(held.lot_id).first();
  return { hold_id: held.id, lot: row };
}

export async function openHolds(db) {
  const { results } = await db
    .prepare(
      `SELECT h.id, h.lot_id, h.reason, h.opened_at, s.name AS opened_by,
              l.short_code, i.name AS item_name
         FROM holds h
         JOIN lots l ON l.id = h.lot_id
         JOIN items i ON i.id = l.item_id
         JOIN staff s ON s.id = h.opened_by
        WHERE h.released_at IS NULL
        ORDER BY h.opened_at`,
    )
    .all();
  return results || [];
}
