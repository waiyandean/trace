import { BadRequest } from '../http.js';
import {
  validateEnvelope, payloadHash, alreadyAccepted, eventRow, lookupRow,
} from './envelope.js';
import { toBaseUnit } from './units.js';

// P5 — the weekly count.
//
// One submission is one count sheet: many (item, location) lines, each a
// figure somebody counted off a shelf. For each line the ledger's own
// balance for that item at that location is computed from the movements, and
// the difference between the two is written as `ADJUST` movements so the
// balances self-correct (PLAN.md, "The model").
//
// Two decisions from Dean (2026-09-09) run through this file:
//
// - **The count is item + location, never per lot.** Staff count "how much
//   hoi sin is in the walk-in", not "how much of lot K4M2..". A countable jar
//   is whole-pack so its lot is never ambiguous, and a part-used bulk tub
//   cannot be split by lot on sight — so the sheet asks for the one figure
//   the floor can actually give.
//
// - **A variance is spread across that item's open lots at the location
//   pro-rata by each lot's balance.** The count cannot see which lot drifted,
//   so it assumes nothing. Pro-rata by a positive balance also keeps every
//   lot at or above zero: a shortfall is at most the whole balance, and each
//   lot only ever gives up its own share of it.
//
// Like dispatch and the stock screen this is online-only and deviceless: it
// mints no codes and is measured against live balances a cached copy would
// get wrong the moment someone else moved something. Every line is validated
// before anything is written, so a count is recorded whole or not at all.

// Below this, a variance is rounding noise from the unit conversion rather
// than a real discrepancy, and the line is recorded as matching.
const NOISE = 1e-6;

// An ADJUST smaller than this would be a movement of practically nothing and
// trips the `quantity <> 0` check for no benefit, so its share is folded into
// the largest lot instead.
const DUST = 1e-9;

function requireCount(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BadRequest(`${field} must be a number of zero or more, got ${JSON.stringify(value)}`);
  }
  return value;
}

// The ledger balance for one item at one location, and the per-lot balances
// that make it up. Only lots holding a positive balance there are apportion
// targets: a lot that has fully left cannot absorb a correction.
async function ledgerAt(db, itemId, locationId) {
  const { results } = await db
    .prepare(
      `SELECT l.id AS lot_id, l.status,
              COALESCE(SUM(m.quantity), 0) AS quantity
         FROM lots l
         JOIN movements m ON m.lot_id = l.id
        WHERE l.item_id = ?
          AND COALESCE(m.to_location_id, m.from_location_id) = ?
        GROUP BY l.id
        HAVING quantity <> 0
        ORDER BY quantity DESC, l.id ASC`,
    )
    .bind(itemId, locationId)
    .all();
  const lots = (results || []).filter((row) => row.quantity > 0);
  const total = (results || []).reduce((sum, row) => sum + row.quantity, 0);
  return { total, lots };
}

// Split `variance` across `lots` in proportion to each lot's balance. The
// last unit of rounding lands on the largest lot (the list arrives sorted
// balance-descending) so the shares always sum back to the variance exactly.
function apportion(variance, lots) {
  const weight = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const shares = [];
  let assigned = 0;
  for (let i = 1; i < lots.length; i += 1) {
    const share = (variance * lots[i].quantity) / weight;
    assigned += share;
    if (Math.abs(share) >= DUST) shares.push({ lotId: lots[i].lot_id, quantity: share });
  }
  const remainder = variance - assigned;
  if (Math.abs(remainder) >= DUST) shares.unshift({ lotId: lots[0].lot_id, quantity: remainder });
  return shares;
}

async function prepareLine(db, line, where) {
  if (!line || typeof line !== 'object') throw new BadRequest(`${where} must be an object`);

  const item = await lookupRow(db, 'SELECT id, name, base_unit FROM items WHERE id = ?', line.item_id);
  if (!item) throw new BadRequest(`${where}: unknown item ${JSON.stringify(line.item_id)}`);

  const location = await lookupRow(db, 'SELECT id, name, active FROM locations WHERE id = ?', line.location_id);
  if (!location) throw new BadRequest(`${where}: unknown location ${JSON.stringify(line.location_id)}`);
  if (location.active !== 1) throw new BadRequest(`${where}: ${location.name} is not an active location`);

  // Staff key each tier they handle — cases, individual units, loose weight —
  // and the line total is their sum in the item's base unit (PLAN.md open
  // question 4: ask in the pack unit, not a weight somebody works out). A line
  // may instead carry a single `counted_quantity` (+ optional `unit`), which
  // is the one-tier form of the same thing.
  const tiers = Array.isArray(line.entries)
    ? line.entries
    : line.counted_quantity !== undefined
      ? [{ quantity: line.counted_quantity, unit: line.unit || item.base_unit }]
      : null;
  if (tiers === null) throw new BadRequest(`${where}: needs entries or counted_quantity`);

  const entries = [];
  let countedBase = 0;
  for (const [t, tier] of tiers.entries()) {
    const quantity = requireCount(tier && tier.quantity, `${where}.entries[${t}].quantity`);
    if (quantity === 0) continue; // a blank tier is simply not counted
    const unit = typeof tier.unit === 'string' && tier.unit ? tier.unit : item.base_unit;
    const converted = await toBaseUnit(db, item, quantity, unit);
    entries.push({ enteredQuantity: quantity, enteredUnit: unit, baseQuantity: converted.quantity });
    countedBase += converted.quantity;
  }

  // Kept on count_lines only when the line is a single tier; a multi-tier
  // line's figures live in count_line_entries and these stay null.
  const single = entries.length === 1 ? entries[0] : null;

  const ledger = await ledgerAt(db, item.id, location.id);
  const variance = countedBase - ledger.total;

  let disposition;
  let adjustments = [];
  if (Math.abs(variance) < NOISE) {
    disposition = 'no_variance';
  } else if (ledger.lots.length === 0) {
    // Stock on the shelf that the ledger has no open lot for. The system
    // will not open one to balance to — that is exactly the invented link
    // this project exists to remove — so the gap is recorded and left for a
    // person (GET /api/counts?open).
    disposition = 'unresourced';
  } else {
    disposition = 'apportioned';
    adjustments = apportion(variance, ledger.lots);
    if (adjustments.length === 0) disposition = 'no_variance';
  }

  return {
    item,
    location,
    entries,
    enteredQuantity: single ? single.enteredQuantity : null,
    enteredUnit: single ? single.enteredUnit : null,
    countedBase,
    ledgerQuantity: ledger.total,
    variance,
    disposition,
    adjustments,
    note: typeof line.note === 'string' ? line.note : null,
  };
}

export async function recordCount(db, payload) {
  const envelope = await validateEnvelope(db, payload, { requireDevice: false });
  const hash = await payloadHash(payload);
  const existing = await alreadyAccepted(db, envelope.idempotency_key, hash);
  if (existing) return { duplicate: true, ...(await countResult(db, existing.id)) };

  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new BadRequest('lines must be a non-empty array: a count of nothing is not a count');
  }

  const lines = [];
  for (const [index, line] of payload.lines.entries()) {
    lines.push(await prepareLine(db, line, `lines[${index}]`));
  }

  // The same item in the same place twice on one sheet is a slip: the two
  // figures would be measured against the same ledger balance and only the
  // last would stand. Two locations for one item is ordinary.
  const keys = lines.map((row) => `${row.item.id}@${row.location.id}`);
  if (new Set(keys).size !== keys.length) {
    throw new BadRequest('the same item is counted twice in the same place: add the two figures together');
  }

  const statements = [
    eventRow(db, envelope, 'count', hash, payload),
    db
      .prepare('INSERT INTO counts (event_id, counted_at, counted_by, note) VALUES (?, ?, ?, ?)')
      .bind(envelope.event_id, envelope.occurred_at, envelope.staff_id, payload.note ?? null),
  ];

  lines.forEach((line, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO count_lines (id, event_id, item_id, location_id, counted_quantity,
                                    entered_quantity, entered_unit, ledger_quantity, variance, disposition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${envelope.event_id}-L${index}`,
          envelope.event_id,
          line.item.id,
          line.location.id,
          line.countedBase,
          line.enteredQuantity,
          line.enteredUnit,
          line.ledgerQuantity,
          line.variance,
          line.disposition,
        ),
    );

    line.entries.forEach((entry, at) => {
      statements.push(
        db
          .prepare(
            `INSERT INTO count_line_entries (id, count_line_id, entered_quantity, entered_unit, base_quantity)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            `${envelope.event_id}-L${index}-E${at}`,
            `${envelope.event_id}-L${index}`,
            entry.enteredQuantity,
            entry.enteredUnit,
            entry.baseQuantity,
          ),
      );
    });

    line.adjustments.forEach((adj, at) => {
      statements.push(
        db
          .prepare(
            `INSERT INTO movements (id, lot_id, type, quantity, from_location_id, to_location_id,
                                    occurred_at, staff_id, event_id, note)
             VALUES (?, ?, 'ADJUST', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `${envelope.event_id}-ADJ-${index}-${at}`,
            adj.lotId,
            adj.quantity,
            adj.quantity < 0 ? line.location.id : null,
            adj.quantity > 0 ? line.location.id : null,
            envelope.occurred_at,
            envelope.staff_id,
            envelope.event_id,
            line.note,
          ),
      );
    });
  });

  await db.batch(statements);
  return { duplicate: false, ...(await countResult(db, envelope.event_id)) };
}

// What one count recorded, for a fresh submission and for the replay of one
// already accepted. Each line carries its counted and ledger figures, the
// variance, and how it was resolved.
export async function countResult(db, eventId) {
  const [head, lines, entries] = await Promise.all([
    db
      .prepare(
        `SELECT c.event_id, c.counted_at, c.note, s.name AS counted_by
           FROM counts c
      LEFT JOIN staff s ON s.id = c.counted_by
          WHERE c.event_id = ?`,
      )
      .bind(eventId)
      .first(),
    db
      .prepare(
        `SELECT cl.id, cl.item_id, i.name AS item_name, i.base_unit,
                cl.location_id, loc.name AS location_name,
                cl.counted_quantity, cl.entered_quantity, cl.entered_unit,
                cl.ledger_quantity, cl.variance, cl.disposition,
                cl.resolved_at, rs.name AS resolved_by, cl.resolve_note
           FROM count_lines cl
           JOIN items i ON i.id = cl.item_id
           JOIN locations loc ON loc.id = cl.location_id
      LEFT JOIN staff rs ON rs.id = cl.resolved_by
          WHERE cl.event_id = ?
          ORDER BY i.name, loc.name`,
      )
      .bind(eventId)
      .all(),
    db
      .prepare(
        `SELECT e.count_line_id, e.entered_quantity, e.entered_unit, e.base_quantity
           FROM count_line_entries e
           JOIN count_lines cl ON cl.id = e.count_line_id
          WHERE cl.event_id = ?
          ORDER BY e.id`,
      )
      .bind(eventId)
      .all(),
  ]);

  const byLine = new Map();
  for (const entry of entries.results || []) {
    if (!byLine.has(entry.count_line_id)) byLine.set(entry.count_line_id, []);
    byLine.get(entry.count_line_id).push({
      entered_quantity: entry.entered_quantity,
      entered_unit: entry.entered_unit,
      base_quantity: entry.base_quantity,
    });
  }
  const rows = (lines.results || []).map((row) => ({ ...row, entries: byLine.get(row.id) || [] }));

  return { event_id: eventId, count: head, lines: rows };
}

// Recent counts, newest first: one row per sheet with the line count and how
// many of its lines are still unresolved.
export async function recentCounts(db, { limit = 50 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT c.event_id, c.counted_at, s.name AS counted_by, c.note,
              COUNT(cl.id) AS line_count,
              COALESCE(SUM(CASE WHEN cl.disposition = 'unresourced'
                                 AND cl.resolved_at IS NULL THEN 1 ELSE 0 END), 0) AS open_count
         FROM counts c
    LEFT JOIN staff s ON s.id = c.counted_by
    LEFT JOIN count_lines cl ON cl.event_id = c.event_id
     GROUP BY c.event_id
     ORDER BY c.counted_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results || [];
}

// The count lines nobody has resolved: stock that was counted with no lot to
// carry it. This is the P6 "missing lot" alert in its first form.
export async function openCountLines(db) {
  const { results } = await db
    .prepare(
      `SELECT cl.id, cl.event_id, c.counted_at, cl.item_id, i.name AS item_name, i.base_unit,
              cl.location_id, loc.name AS location_name,
              cl.counted_quantity, cl.ledger_quantity, cl.variance
         FROM count_lines cl
         JOIN counts c ON c.event_id = cl.event_id
         JOIN items i ON i.id = cl.item_id
         JOIN locations loc ON loc.id = cl.location_id
        WHERE cl.disposition = 'unresourced' AND cl.resolved_at IS NULL
        ORDER BY c.counted_at, i.name`,
    )
    .all();
  return results || [];
}

// Close one such line by hand once the stock has been traced to a lot or the
// sheet corrected. It records who and when; it writes no movement, because
// what the correct adjustment is depends on what the person found.
export async function resolveCountLine(db, payload) {
  const line = await db
    .prepare('SELECT id, disposition, resolved_at FROM count_lines WHERE id = ?')
    .bind(payload.line_id)
    .first();
  if (!line) throw new BadRequest(`unknown count line ${JSON.stringify(payload.line_id)}`);
  if (line.disposition !== 'unresourced') {
    throw new BadRequest('that count line resolved itself when it was recorded; there is nothing to close');
  }
  if (line.resolved_at) throw new BadRequest('that count line was already resolved');

  const staff = await lookupRow(db, 'SELECT id, name, active FROM staff WHERE id = ?', payload.staff_id);
  if (!staff) throw new BadRequest(`unknown staff ${JSON.stringify(payload.staff_id)}`);
  if (staff.active !== 1) throw new BadRequest(`${staff.name} is not active`);

  const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.trim() : null;

  await db.batch([
    db
      .prepare(
        `UPDATE count_lines SET resolved_at = datetime('now'), resolved_by = ?, resolve_note = ?
          WHERE id = ? AND resolved_at IS NULL`,
      )
      .bind(staff.id, note, line.id),
  ]);

  return { line_id: line.id, resolved_by: staff.name };
}
