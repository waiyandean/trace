import { BadRequest } from '../http.js';
import { loadLimits, withinLimit, requireReading } from './temperature.js';

// Closing a temperature deviation.
//
// A hold that nobody can clear is a hold staff route around, and a hold that
// clears itself is not a hold. So this is the one place a lot leaves `held`,
// and it cannot happen without a second reading, an outcome and a name.
//
// The kitchen's existing deviation record is the argument for the shape: its
// recheck was due at 14:02 and was taken seven days later. Nothing was wrong
// with the decision — the stock came back at -19 and was fine — but nothing
// chased it either. Here the stock stays unusable until somebody says what
// happened, and how late that was is on the record.

const OUTCOMES = ['resolved', 'rejected', 'disposed'];

export async function openDeviations(db) {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.lot_id, d.opened_at, d.recheck_due_at,
              r.kind, r.celsius, r.limit_celsius,
              l.short_code, l.batch_code, i.name AS item_name, i.base_unit,
              s.name AS supplier_name
         FROM temperature_deviations d
         JOIN temperature_readings r ON r.id = d.reading_id
    LEFT JOIN lots l ON l.id = d.lot_id
    LEFT JOIN items i ON i.id = l.item_id
    LEFT JOIN suppliers s ON s.id = l.supplier_id
        WHERE d.outcome IS NULL
        ORDER BY d.recheck_due_at`,
    )
    .all();
  return results || [];
}

// Resolving needs a reading that is actually within limit. Anything else is
// either a rejection or a disposal, and calling it resolved would put "this
// was fine" on a record that says otherwise.
export async function closeDeviation(db, payload) {
  if (!payload || typeof payload !== 'object') throw new BadRequest('the body must be a JSON object');

  const deviation = await db
    .prepare(
      `SELECT d.id, d.lot_id, d.outcome, r.kind, r.limit_celsius
         FROM temperature_deviations d
         JOIN temperature_readings r ON r.id = d.reading_id
        WHERE d.id = ?`,
    )
    .bind(payload.deviation_id)
    .first();
  if (!deviation) throw new BadRequest(`unknown deviation ${JSON.stringify(payload.deviation_id)}`);
  if (deviation.outcome) {
    throw new BadRequest(`that deviation was already closed as ${deviation.outcome}`);
  }

  if (!OUTCOMES.includes(payload.outcome)) {
    throw new BadRequest(`outcome must be one of: ${OUTCOMES.join(', ')}`);
  }

  const staff = await db.prepare('SELECT id, name, active FROM staff WHERE id = ?').bind(payload.staff_id).first();
  if (!staff) throw new BadRequest(`unknown staff ${JSON.stringify(payload.staff_id)}`);
  if (staff.active !== 1) throw new BadRequest(`${staff.name} is not active`);

  const limits = await loadLimits(db);
  const limitCelsius = deviation.limit_celsius;

  let recheck = null;
  if (payload.recheck_celsius !== undefined && payload.recheck_celsius !== null) {
    recheck = requireReading(payload.recheck_celsius, 'recheck_celsius');
  }

  if (payload.outcome === 'resolved') {
    if (recheck === null) {
      throw new BadRequest('a deviation cannot be resolved without a second reading');
    }
    if (!withinLimit(recheck, limitCelsius)) {
      throw new BadRequest(
        `${recheck}°C is still outside the ${limitCelsius}°C limit, so this is not resolved. ` +
          'Reject or dispose of the stock, or take another reading.',
      );
    }
  }

  const rechecked = payload.rechecked_at || new Date().toISOString();

  const statements = [
    db
      .prepare(
        `UPDATE temperature_deviations
            SET rechecked_at = ?, recheck_celsius = ?, outcome = ?, outcome_note = ?,
                closed_at = datetime('now'), closed_by = ?
          WHERE id = ? AND outcome IS NULL`,
      )
      .bind(
        recheck === null ? null : rechecked,
        recheck,
        payload.outcome,
        payload.note ?? null,
        staff.id,
        deviation.id,
      ),
  ];

  // The lot only returns to open when nothing else is still holding it. A
  // warm van and a warm probe can both hold the same lot, and clearing one
  // must not release stock the other is still holding.
  if (deviation.lot_id && payload.outcome === 'resolved') {
    statements.push(
      db
        .prepare(
          `UPDATE lots SET status = 'open', updated_at = datetime('now')
            WHERE id = ? AND status = 'held'
              AND NOT EXISTS (
                SELECT 1 FROM temperature_deviations
                 WHERE lot_id = lots.id AND outcome IS NULL AND id <> ?
              )`,
        )
        .bind(deviation.lot_id, deviation.id),
    );
  }

  // Rejected or disposed stock is not usable, and saying so on the lot is
  // what stops it appearing in a picker later. The stock movement that empties
  // it is P2's WASTE; until that exists the status is the honest record.
  if (deviation.lot_id && payload.outcome !== 'resolved') {
    statements.push(
      db
        .prepare("UPDATE lots SET status = 'written_off', updated_at = datetime('now') WHERE id = ?")
        .bind(deviation.lot_id),
    );
  }

  await db.batch(statements);

  const lot = deviation.lot_id
    ? await db.prepare('SELECT id, status FROM lots WHERE id = ?').bind(deviation.lot_id).first()
    : null;
  return { deviation_id: deviation.id, outcome: payload.outcome, lot, limits };
}
