import { BadRequest } from '../http.js';

// P6 — the recall walk.
//
// `traceLot` in reports.js stops after one hop, which cannot answer the
// question an audit actually asks: given a bad lot of an ingredient, which
// customers received product made from it. That needs the whole chain —
// ingredient lot, the batches it went into, the product lots those made, the
// dispatches those went out on — and PLAN.md's P7 makes a timed mock recall
// of exactly this the exit criterion for cutting over.
//
// The walk goes level by level, one query per level per table rather than one
// per lot, so a deep or wide chain costs a handful of round trips against D1.
//
// A recall is deliberately conservative. Nothing here apportions a
// consumption: if 2 kg of a bad lot went into a 40 L batch, the whole batch is
// listed as affected, because nothing records which of the 40 L held it.
//
// What the ledger cannot see is reported, not dropped. An `unproven_inputs`
// row is a batch that used an item with no lot named, so a recall on that
// item cannot rule the batch out; it is returned under `gaps` rather than
// left off a list that would then look complete.

// Real chains here are about three hops deep (ingredient, oil, broth,
// dispatch). Hitting the cap means something is wrong with the data, so it is
// reported as `truncated` instead of quietly cutting the answer short.
export const MAX_DEPTH = 10;

// D1 allows 100 bound parameters a statement.
const CHUNK = 80;

const DIRECTIONS = ['forward', 'back'];

async function inChunks(ids, run) {
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    rows.push(...(await run(ids.slice(i, i + CHUNK))));
  }
  return rows;
}

const marks = (ids) => ids.map(() => '?').join(', ');

// The genealogy edge is a CONSUME movement: it sits on the lot consumed and
// names the lot it fed as its counterpart (produce.js). Forward from a lot
// reads the movements written against it; back reads the ones naming it as
// the counterpart. `COMBINE` is written by nothing (PLAN.md, open question
// 8), so there is no second edge kind to follow.
async function edgesFrom(db, ids, direction) {
  const forward = direction === 'forward';
  return inChunks(ids, async (chunk) => {
    const { results } = await db
      .prepare(
        `SELECT ${forward ? 'm.lot_id' : 'm.counterpart_lot_id'} AS from_id,
                ${forward ? 'm.counterpart_lot_id' : 'm.lot_id'} AS to_id,
                SUM(-m.quantity) AS quantity
           FROM movements m
          WHERE m.type = 'CONSUME' AND m.counterpart_lot_id IS NOT NULL
            AND ${forward ? 'm.lot_id' : 'm.counterpart_lot_id'} IN (${marks(chunk)})
          GROUP BY from_id, to_id`,
      )
      .bind(...chunk)
      .all();
    return results || [];
  });
}

// Breadth-first, with a visited set. A lot reached twice is normal — A feeds
// B and C, and both feed D — so it is shown once and records every lot that
// reached it in `from`. It is not expanded a second time, which is also what
// stops a cycle looping.
async function walk(db, startId, direction) {
  const reached = new Map([[startId, { depth: 0, from: [] }]]);
  const edges = [];
  let frontier = [startId];
  let depth = 0;

  while (frontier.length && depth < MAX_DEPTH) {
    depth += 1;
    const next = [];
    for (const edge of await edgesFrom(db, frontier, direction)) {
      edges.push({ from: edge.from_id, to: edge.to_id, quantity: edge.quantity });
      const seen = reached.get(edge.to_id);
      if (seen) {
        if (!seen.from.includes(edge.from_id)) seen.from.push(edge.from_id);
      } else {
        reached.set(edge.to_id, { depth, from: [edge.from_id] });
        next.push(edge.to_id);
      }
    }
    frontier = next;
  }
  return { reached, edges, truncated: frontier.length > 0 };
}

async function lotRows(db, ids) {
  return inChunks(ids, async (chunk) => {
    const { results } = await db
      .prepare(
        `SELECT l.id, l.item_id, i.name AS item_name, i.base_unit, l.short_code, l.batch_code,
                l.origin, l.status, l.use_by, l.originated_at,
                l.supplier_id, s.name AS supplier_name, l.supplier_lot, l.supplier_invoice,
                (EXISTS (SELECT 1 FROM holds h WHERE h.lot_id = l.id AND h.released_at IS NULL)
                 OR EXISTS (SELECT 1 FROM temperature_deviations d
                             WHERE d.lot_id = l.id AND d.outcome IS NULL)) AS held
           FROM lots l JOIN items i ON i.id = l.item_id
           LEFT JOIN suppliers s ON s.id = l.supplier_id
          WHERE l.id IN (${marks(chunk)})`,
      )
      .bind(...chunk)
      .all();
    return results || [];
  });
}

// Stock still in the building, per lot per location. The same derivation
// every balance in this system uses: the sum of the movements, never a stored
// figure.
async function onHand(db, ids) {
  return inChunks(ids, async (chunk) => {
    const { results } = await db
      .prepare(
        `WITH balances AS (
           SELECT lot_id, COALESCE(to_location_id, from_location_id) AS location_id,
                  SUM(quantity) AS quantity
             FROM movements WHERE lot_id IN (${marks(chunk)}) GROUP BY lot_id, location_id
         )
         SELECT b.lot_id, b.location_id, loc.name AS location_name, b.quantity
           FROM balances b JOIN locations loc ON loc.id = b.location_id
          WHERE b.quantity > 0`,
      )
      .bind(...chunk)
      .all();
    return results || [];
  });
}

async function dispatched(db, ids) {
  return inChunks(ids, async (chunk) => {
    const { results } = await db
      .prepare(
        `SELECT d.event_id, d.customer_id, c.name AS customer_name, d.reference,
                m.lot_id, -m.quantity AS quantity, m.occurred_at
           FROM movements m
           JOIN dispatches d ON d.event_id = m.event_id
           JOIN customers c ON c.id = d.customer_id
          WHERE m.type = 'DISPATCH' AND m.lot_id IN (${marks(chunk)})
          ORDER BY m.occurred_at, c.name`,
      )
      .bind(...chunk)
      .all();
    return results || [];
  });
}

async function wasted(db, ids) {
  return inChunks(ids, async (chunk) => {
    const { results } = await db
      .prepare(
        `SELECT m.lot_id, -m.quantity AS quantity, m.reason, m.occurred_at
           FROM movements m
          WHERE m.type = 'WASTE' AND m.lot_id IN (${marks(chunk)})
          ORDER BY m.occurred_at`,
      )
      .bind(...chunk)
      .all();
    return results || [];
  });
}

const UNPROVEN = `SELECT u.lot_id AS batch_lot_id, b.short_code AS batch_short_code,
                         b.batch_code, b.originated_at AS batch_originated_at,
                         bi.name AS batch_item_name,
                         u.item_id, ui.name AS item_name, u.quantity, u.unit, u.reason
                    FROM unproven_inputs u
                    JOIN lots b ON b.id = u.lot_id
                    JOIN items bi ON bi.id = b.item_id
                    JOIN items ui ON ui.id = u.item_id`;

// Going forward: batches that used an item this walk touched, with no lot
// named, at a time the lot could have been in the building. They are not
// proven to contain it and not proven not to, so they are listed. Batches
// already in the walk are left out — they are affected outright, so a gap
// entry would only repeat them weaker. The candidate window is between the
// lot arriving and its use-by; a lot with no use-by has no upper bound.
async function possibleDownstream(db, lots, reached) {
  const itemIds = [...new Set(lots.map((lot) => lot.item_id))];
  const rows = await inChunks(itemIds, async (chunk) => {
    const { results } = await db
      .prepare(`${UNPROVEN} WHERE u.item_id IN (${marks(chunk)}) ORDER BY b.originated_at`)
      .bind(...chunk)
      .all();
    return results || [];
  });

  const gaps = [];
  for (const row of rows) {
    if (reached.has(row.batch_lot_id)) continue;
    const day = String(row.batch_originated_at).slice(0, 10);
    const candidates = lots.filter((lot) => lot.item_id === row.item_id
      && day >= String(lot.originated_at).slice(0, 10)
      && (!lot.use_by || day <= String(lot.use_by).slice(0, 10)));
    if (!candidates.length) continue;
    gaps.push({
      kind: 'possible_downstream',
      batch_lot_id: row.batch_lot_id,
      batch_short_code: row.batch_short_code,
      batch_code: row.batch_code,
      batch_item_name: row.batch_item_name,
      item_name: row.item_name,
      quantity: row.quantity,
      unit: row.unit,
      reason: row.reason,
      could_be: candidates.map((lot) => lot.id),
    });
  }
  return gaps;
}

// Going back: a batch in the ancestry that used something with no lot named.
// The chain above that input is missing, and a trace that ended there without
// saying so would read as complete.
async function missingUpstream(db, ids) {
  const rows = await inChunks(ids, async (chunk) => {
    const { results } = await db
      .prepare(`${UNPROVEN} WHERE u.lot_id IN (${marks(chunk)}) ORDER BY b.originated_at`)
      .bind(...chunk)
      .all();
    return results || [];
  });
  return rows.map((row) => ({
    kind: 'missing_upstream',
    batch_lot_id: row.batch_lot_id,
    batch_short_code: row.batch_short_code,
    batch_code: row.batch_code,
    batch_item_name: row.batch_item_name,
    item_name: row.item_name,
    quantity: row.quantity,
    unit: row.unit,
    reason: row.reason,
  }));
}

// `forward` answers "who did this reach"; `back` answers "what was this made
// from, and who supplied it". Both return the same shape, so one screen and
// one set of tests cover them.
export async function recall(db, lotId, direction = 'forward') {
  if (!lotId) throw new BadRequest('lot is required');
  if (!DIRECTIONS.includes(direction)) {
    throw new BadRequest(`direction must be one of ${DIRECTIONS.join(', ')}`);
  }

  const { reached, edges, truncated } = await walk(db, lotId, direction);
  const ids = [...reached.keys()];
  const rows = await lotRows(db, ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const start = byId.get(lotId);
  if (!start) throw new BadRequest(`no lot ${JSON.stringify(lotId)}`);

  const lots = ids
    .filter((id) => id !== lotId && byId.has(id))
    .map((id) => ({ ...byId.get(id), held: Boolean(byId.get(id).held), ...reached.get(id) }))
    .sort((a, b) => a.depth - b.depth || a.item_name.localeCompare(b.item_name));

  const [stock, sent, binned, gaps] = await Promise.all([
    onHand(db, ids),
    dispatched(db, ids),
    wasted(db, ids),
    direction === 'forward'
      ? possibleDownstream(db, rows, reached)
      : missingUpstream(db, ids),
  ]);

  const named = (row) => {
    const lot = byId.get(row.lot_id);
    return {
      ...row,
      item_name: lot.item_name,
      base_unit: lot.base_unit,
      short_code: lot.short_code,
      batch_code: lot.batch_code,
      use_by: lot.use_by,
    };
  };

  return {
    direction,
    start: { ...start, held: Boolean(start.held) },
    max_depth: MAX_DEPTH,
    truncated,
    lots,
    edges,
    customers: sent.map(named),
    on_hand: stock.map(named),
    wasted: binned.map(named),
    gaps,
  };
}
