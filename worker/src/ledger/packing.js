import { BadRequest } from '../http.js';
import { validateEnvelope, requireQuantity, payloadHash, alreadyAccepted, eventRow, lookupRow } from './envelope.js';
import { toBaseUnit } from './units.js';

// Packing a batch out: how much it made, into how many packets, and the mass
// balance that makes it worth recording.
//
// This is where the product comes into existence as stock. The batch consumed
// its ingredients when they went in; the `PRODUCE` movement is written here,
// because until something is out of the pot there is nothing to put on a
// shelf.
//
// Packets produced is not bookkeeping. It is the output side of what went in
// against what came out, which is how the kitchen sees that every ingredient
// is accounted for (Dean, 2026-09-02). A batch that consumed sixty kilograms
// and packed twelve has either lost something or recorded something wrongly,
// and both are worth knowing.
//
// It happens after the batch and sometimes by somebody else, so it is its own
// submission rather than a field on the batch form nobody is standing at.

// Every batch that is not finished, and what each is waiting for.
//
// One list rather than three. A batch needs its temperatures taken, then
// packing out, and both are things somebody comes back to — often a different
// somebody, hours later. Splitting them across separate screens would mean
// two places to remember to look, and the one nobody looks at is where a
// cooling check goes to die.
export async function openBatches(db) {
  const { results } = await db
    .prepare(
      `SELECT b.lot_id, b.yield_quantity, b.multiplier, b.packed_at, b.created_at,
              i.name AS product_name, i.base_unit, l.short_code, l.use_by, l.status,
              l.originated_at, s.name AS started_by,
              (SELECT COUNT(*) FROM checkpoint_readings r
                WHERE r.lot_id = b.lot_id AND r.recorded_at IS NULL) AS checks_outstanding,
              (SELECT COUNT(*) FROM checkpoint_readings r
                WHERE r.lot_id = b.lot_id AND r.recorded_at IS NULL
                  AND r.due_at <= datetime('now')) AS checks_overdue,
              (SELECT COUNT(*) FROM holds h
                WHERE h.lot_id = b.lot_id AND h.released_at IS NULL) AS holds_open
         FROM batch_records b
         JOIN lots l ON l.id = b.lot_id
         JOIN items i ON i.id = l.item_id
    LEFT JOIN events e ON e.id = b.event_id
    LEFT JOIN staff s ON s.id = e.staff_id
        WHERE b.packed_at IS NULL OR EXISTS (
          SELECT 1 FROM checkpoint_readings r WHERE r.lot_id = b.lot_id AND r.recorded_at IS NULL
        )
        ORDER BY b.created_at`,
    )
    .all();
  return results || [];
}

// What one batch still needs, in the order somebody would do it.
export async function batchDetail(db, lotId) {
  const [batch, checks, inputs] = await Promise.all([
    db
      .prepare(
        `SELECT b.*, i.name AS product_name, i.base_unit, l.short_code, l.use_by, l.status
           FROM batch_records b JOIN lots l ON l.id = b.lot_id JOIN items i ON i.id = l.item_id
          WHERE b.lot_id = ?`,
      )
      .bind(lotId)
      .first(),
    db
      .prepare(
        `SELECT r.id, r.due_at, r.recorded_at, r.celsius, r.confirmed, r.observed_at,
                r.within_limit, c.code, c.label, c.kind, c.is_ccp, c.min_celsius, c.max_celsius,
                c.anchor_code, c.due_minutes, c.sort_order
           FROM checkpoint_readings r JOIN checkpoints c ON c.id = r.checkpoint_id
          WHERE r.lot_id = ? ORDER BY c.sort_order`,
      )
      .bind(lotId)
      .all(),
    db
      .prepare(
        `SELECT i.name, -m.quantity AS quantity, i.base_unit, src.short_code, src.batch_code
           FROM movements m JOIN lots src ON src.id = m.lot_id JOIN items i ON i.id = src.item_id
          WHERE m.counterpart_lot_id = ? AND m.type = 'CONSUME' ORDER BY i.name`,
      )
      .bind(lotId)
      .all(),
  ]);
  if (!batch) throw new BadRequest(`no batch was recorded for lot ${JSON.stringify(lotId)}`);
  return { batch, checks: checks.results || [], inputs: inputs.results || [] };
}

export async function recordPacking(db, payload) {
  const envelope = await validateEnvelope(db, payload, { requireDevice: false });
  const hash = await payloadHash(payload);
  const existing = await alreadyAccepted(db, envelope.idempotency_key, hash);
  if (existing) return { duplicate: true, event_id: existing.id };

  const record = await db
    .prepare(
      `SELECT b.lot_id, b.packed_at, b.event_id, i.id AS item_id, i.name AS item_name, i.base_unit
         FROM batch_records b JOIN lots l ON l.id = b.lot_id JOIN items i ON i.id = l.item_id
        WHERE b.lot_id = ?`,
    )
    .bind(payload.lot_id)
    .first();
  if (!record) throw new BadRequest(`no batch was recorded for lot ${JSON.stringify(payload.lot_id)}`);
  if (record.packed_at) throw new BadRequest('that batch has already been packed out');

  const location = await lookupRow(db, 'SELECT id, name, active FROM locations WHERE id = ?', payload.location_id);
  if (!location) throw new BadRequest(`unknown location ${JSON.stringify(payload.location_id)}`);
  if (location.active !== 1) throw new BadRequest(`${location.name} is not an active location`);

  const yielded = requireQuantity(payload.yield_quantity, 'yield_quantity');
  const unit = payload.yield_unit || record.base_unit;
  const converted = await toBaseUnit(db, record, yielded, unit);

  // Zero is a real answer — a batch can fail and pack nothing — so it is
  // allowed, and only a missing or negative count is refused.
  const packets = payload.packets_produced;
  if (!Number.isInteger(packets) || packets < 0) {
    throw new BadRequest(`packets_produced must be a whole number, got ${JSON.stringify(packets)}`);
  }
  if (typeof payload.label_check !== 'boolean') {
    throw new BadRequest('label_check must be true or false: it says the packets carry their label');
  }

  await db.batch([
    eventRow(db, envelope, 'produce', hash, payload),
    // The product becomes stock here, not when the batch started.
    db
      .prepare(
        `INSERT INTO movements (id, lot_id, type, quantity, entered_quantity, entered_unit,
                                to_location_id, occurred_at, staff_id, event_id)
         VALUES (?, ?, 'PRODUCE', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `${envelope.event_id}-PRODUCE`,
        record.lot_id,
        converted.quantity,
        yielded,
        unit,
        location.id,
        envelope.occurred_at,
        envelope.staff_id,
        envelope.event_id,
      ),
    db
      .prepare(
        `UPDATE batch_records
            SET yield_quantity = ?, packets_produced = ?, label_check = ?,
                packed_at = ?, packed_by = ?, packed_event = ?
          WHERE lot_id = ? AND packed_at IS NULL`,
      )
      .bind(converted.quantity, packets, payload.label_check ? 1 : 0, envelope.occurred_at,
            envelope.staff_id, envelope.event_id, record.lot_id),
  ]);

  return { duplicate: false, event_id: envelope.event_id, ...(await massBalance(db, record.lot_id)) };
}

// What went in against what came out.
//
// Reported rather than enforced, and reported honestly: inputs in a different
// unit from the output cannot be summed, and an unproven input has a quantity
// but no lot. Both are stated instead of being quietly dropped, because a
// balance that looks clean by ignoring what it cannot add is worse than no
// balance at all.
export async function massBalance(db, lotId) {
  const [batch, inputs, unproven] = await Promise.all([
    db
      .prepare(
        `SELECT b.lot_id, b.yield_quantity, b.multiplier, b.packets_produced, b.label_check,
                b.equipment_checked, i.name AS product_name, i.base_unit
           FROM batch_records b JOIN lots l ON l.id = b.lot_id JOIN items i ON i.id = l.item_id
          WHERE b.lot_id = ?`,
      )
      .bind(lotId)
      .first(),
    db
      .prepare(
        `SELECT i.name, i.base_unit, SUM(-m.quantity) AS quantity
           FROM movements m JOIN lots l ON l.id = m.lot_id JOIN items i ON i.id = l.item_id
          WHERE m.counterpart_lot_id = ? AND m.type = 'CONSUME'
          GROUP BY i.id ORDER BY i.name`,
      )
      .bind(lotId)
      .all(),
    db
      .prepare(
        `SELECT i.name, u.quantity, u.unit FROM unproven_inputs u
           JOIN items i ON i.id = u.item_id WHERE u.lot_id = ?`,
      )
      .bind(lotId)
      .all(),
  ]);
  if (!batch) throw new BadRequest(`no batch was recorded for lot ${JSON.stringify(lotId)}`);

  const rows = inputs.results || [];
  if (batch.yield_quantity === null) {
    return {
      lot_id: lotId,
      product: batch.product_name,
      unit: batch.base_unit,
      packets_produced: null,
      balance: null,
      note: 'not packed out yet, so there is nothing to balance against',
    };
  }
  const comparable = rows.filter((row) => row.base_unit === batch.base_unit);
  const otherUnits = rows.filter((row) => row.base_unit !== batch.base_unit);
  const inTotal = comparable.reduce((sum, row) => sum + row.quantity, 0);

  return {
    lot_id: lotId,
    product: batch.product_name,
    unit: batch.base_unit,
    packets_produced: batch.packets_produced,
    balance: {
      // Only the inputs measured in the product's own unit can be added to
      // it. A broth counted in litres made from carcasses counted in
      // kilograms has no arithmetic to do, and pretending otherwise would
      // invent a density.
      input: Number(inTotal.toFixed(3)),
      output: batch.yield_quantity,
      difference: Number((batch.yield_quantity - inTotal).toFixed(3)),
      comparable: comparable.map((row) => ({ name: row.name, quantity: row.quantity })),
      not_comparable: otherUnits.map((row) => ({
        name: row.name, quantity: row.quantity, unit: row.base_unit,
      })),
      unproven: (unproven.results || []).map((row) => ({
        name: row.name, quantity: row.quantity, unit: row.unit,
      })),
    },
  };
}
