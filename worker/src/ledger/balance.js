import { BadRequest } from '../http.js';

// P6 — mass balance across a period.
//
// `massBalance` in packing.js balances one batch: what went in against what
// came out. This is the other question, which no single batch can answer: for
// an item over some weeks, what was there at the start, what arrived or was
// made, where it went, and how much the weekly counts had to correct. It is
// where a supplier short-shipping, a recipe drawing more than it states, or a
// count that keeps correcting the same way would show up.
//
// Every figure is a sum over `movements`. Nothing here is stored, so it cannot
// drift from the events beneath it, and `other` is the proof: it is what is
// left when the flows below are taken off the closing balance, and should
// always be zero. A non-zero `other` means a movement type is being written
// that this report does not know about, which is a bug worth seeing rather
// than a figure to smooth over.
//
// A MOVE writes a negative and a positive row for the same lot, so across all
// locations it nets to nothing and has no column of its own.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['ingredient', 'product'];

const round = (value) => Math.round(value * 1e6) / 1e6;

function requireDate(name, value) {
  // Date.parse rolls 30 February over to March rather than refusing it, so a
  // real date is one that survives the round trip unchanged.
  const parsed = DATE.test(value || '') ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequest(`${name} must be a date, YYYY-MM-DD`);
  }
  return value;
}

// `to` is inclusive, so the period ends at the start of the following day.
// occurred_at is ISO text, so a plain string comparison orders it correctly.
const PERIOD = `
  SELECT i.id AS item_id, i.name, i.kind, i.base_unit,
         EXISTS (SELECT 1 FROM unit_conversions c
                  WHERE c.item_id = i.id AND c.from_unit = 'case' AND c.to_unit = i.base_unit) AS nominal,
         SUM(CASE WHEN m.occurred_at < ?1 THEN m.quantity ELSE 0 END) AS opening,
         SUM(CASE WHEN m.occurred_at >= ?1 AND m.type = 'RECEIVE' THEN m.quantity ELSE 0 END) AS received,
         SUM(CASE WHEN m.occurred_at >= ?1 AND m.type = 'PRODUCE' THEN m.quantity ELSE 0 END) AS produced,
         SUM(CASE WHEN m.occurred_at >= ?1 AND m.type = 'CONSUME' THEN -m.quantity ELSE 0 END) AS consumed,
         SUM(CASE WHEN m.occurred_at >= ?1 AND m.type = 'DISPATCH' THEN -m.quantity ELSE 0 END) AS dispatched,
         SUM(CASE WHEN m.occurred_at >= ?1 AND m.type = 'WASTE' THEN -m.quantity ELSE 0 END) AS wasted,
         SUM(CASE WHEN m.occurred_at >= ?1 AND m.type = 'ADJUST' THEN m.quantity ELSE 0 END) AS adjusted,
         SUM(CASE WHEN m.occurred_at >= ?1 AND m.type = 'ADJUST' AND m.quantity > 0 THEN m.quantity ELSE 0 END) AS adjusted_up,
         SUM(CASE WHEN m.occurred_at >= ?1 AND m.type = 'ADJUST' AND m.quantity < 0 THEN -m.quantity ELSE 0 END) AS adjusted_down,
         SUM(m.quantity) AS closing
    FROM movements m
    JOIN lots l ON l.id = m.lot_id
    JOIN items i ON i.id = l.item_id
   WHERE m.occurred_at < ?2 AND (?3 IS NULL OR i.id = ?3) AND (?4 IS NULL OR i.kind = ?4)
   GROUP BY i.id
   ORDER BY i.name`;

// Consumption the ledger never saw: a batch that used an item with no lot
// named has a quantity but no CONSUME movement. It is not in any figure
// above, so the balance overstates what should be on hand by exactly this,
// and the next count will tend to write it back down as an adjustment.
// Reported beside the row so that adjustment is not mistaken for loss.
const UNPROVEN = `
  SELECT u.item_id, u.unit, SUM(u.quantity) AS quantity
    FROM unproven_inputs u JOIN lots b ON b.id = u.lot_id
   WHERE b.originated_at >= ?1 AND b.originated_at < ?2
   GROUP BY u.item_id, u.unit`;

export async function periodBalance(db, { from, to, item = null, kind = null } = {}) {
  requireDate('from', from);
  requireDate('to', to);
  if (from > to) throw new BadRequest('from must not be after to');
  if (kind && !KINDS.includes(kind)) throw new BadRequest(`kind must be one of ${KINDS.join(', ')}`);

  const end = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

  const [balances, unproven] = await Promise.all([
    db.prepare(PERIOD).bind(from, end, item, kind).all(),
    db.prepare(UNPROVEN).bind(from, end).all(),
  ]);

  const unprovenBy = new Map();
  for (const row of unproven.results || []) {
    if (!unprovenBy.has(row.item_id)) unprovenBy.set(row.item_id, []);
    unprovenBy.get(row.item_id).push({ unit: row.unit, quantity: row.quantity });
  }

  const rows = [];
  for (const raw of balances.results || []) {
    const row = {
      item_id: raw.item_id,
      name: raw.name,
      kind: raw.kind,
      base_unit: raw.base_unit,
      nominal: Boolean(raw.nominal),
      opening: round(raw.opening),
      received: round(raw.received),
      produced: round(raw.produced),
      consumed: round(raw.consumed),
      dispatched: round(raw.dispatched),
      wasted: round(raw.wasted),
      adjusted: round(raw.adjusted),
      adjusted_up: round(raw.adjusted_up),
      adjusted_down: round(raw.adjusted_down),
      closing: round(raw.closing),
    };
    row.other = round(row.closing - (row.opening + row.received + row.produced
      - row.consumed - row.dispatched - row.wasted + row.adjusted));

    // What the counts corrected, against what there was to lose. Null when
    // there was nothing at risk, rather than a division by zero dressed as 0%.
    const atRisk = row.opening + row.received + row.produced;
    row.adjusted_pct = atRisk > 0 ? round((row.adjusted / atRisk) * 100) : null;

    const missed = unprovenBy.get(raw.item_id) || [];
    row.unproven = round(missed.filter((u) => u.unit === raw.base_unit)
      .reduce((sum, u) => sum + u.quantity, 0));
    // Quantities in another unit cannot be added in, so they are stated as
    // they were given rather than dropped or guessed at.
    row.unproven_other_units = missed.filter((u) => u.unit !== raw.base_unit);

    const quiet = [row.opening, row.received, row.produced, row.consumed, row.dispatched,
      row.wasted, row.adjusted, row.closing, row.unproven].every((n) => n === 0)
      && !row.unproven_other_units.length;
    if (!quiet) rows.push(row);
  }

  // Biggest correction first, since that is what somebody opening this wants
  // to see. Items nobody counted or corrected sort last, by name.
  rows.sort((a, b) => (Math.abs(b.adjusted_pct ?? 0) - Math.abs(a.adjusted_pct ?? 0))
    || a.name.localeCompare(b.name));

  return { from, to, rows };
}
