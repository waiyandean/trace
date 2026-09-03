import { BadRequest } from '../http.js';

// Reviewing an unproven input.
//
// PLAN.md's open question was who is allowed to record one and how it is
// supervised. The answer settled on is: nobody is gated at the pot — the
// batch already proceeds on the ingredient going in with no lot named, and a
// block there is worked around with a plausible wrong lot, which is worse.
// So the supervision happens here instead, after the fact, in the same shape
// P1 already used for a temperature deviation: the gap stays open and
// visible until a named person has looked at it.
//
// There is nothing to resolve, unlike a deviation — the ingredient is already
// used. Reviewing is acknowledgement: who looked at it, when, and anything
// they noted. It does not change the batch or the ledger.

export async function openUnproven(db) {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.item_id, u.quantity, u.unit, u.reason, u.created_at,
              u.lot_id AS batch_lot_id, i.name AS item_name,
              p.name AS product_name, l.short_code AS batch_short_code,
              s.name AS staff_name
         FROM unproven_inputs u
         JOIN items i ON i.id = u.item_id
         JOIN lots l ON l.id = u.lot_id
         JOIN items p ON p.id = l.item_id
         JOIN staff s ON s.id = u.staff_id
        WHERE u.reviewed_at IS NULL
        ORDER BY u.created_at`,
    )
    .all();
  return results || [];
}

export async function reviewUnproven(db, payload) {
  if (!payload || typeof payload !== 'object') throw new BadRequest('the body must be a JSON object');

  const row = await db
    .prepare('SELECT id, reviewed_at FROM unproven_inputs WHERE id = ?')
    .bind(payload.unproven_id)
    .first();
  if (!row) throw new BadRequest(`unknown unproven input ${JSON.stringify(payload.unproven_id)}`);
  if (row.reviewed_at) throw new BadRequest('that one was already reviewed');

  const staff = await db.prepare('SELECT id, name, active FROM staff WHERE id = ?').bind(payload.staff_id).first();
  if (!staff) throw new BadRequest(`unknown staff ${JSON.stringify(payload.staff_id)}`);
  if (staff.active !== 1) throw new BadRequest(`${staff.name} is not active`);

  await db.batch([
    db
      .prepare(
        `UPDATE unproven_inputs
            SET reviewed_at = datetime('now'), reviewed_by = ?, review_note = ?
          WHERE id = ? AND reviewed_at IS NULL`,
      )
      .bind(staff.id, payload.note ?? null, row.id),
  ]);

  return { id: row.id, reviewed_by: staff.id };
}
