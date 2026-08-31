import { BadRequest } from '../http.js';

// Reading the ledger back. Enough of P6's views to prove the model as it is
// built, which is the point of writing them alongside each phase rather than
// at the end: a balance that cannot be read is a balance nobody has checked.
//
// Quantity on hand is never stored. It is the sum of the movements, computed
// here every time, so it cannot disagree with the events beneath it.

const LOT_COLUMNS = `l.id, l.item_id, i.name AS item_name, i.base_unit, l.short_code, l.batch_code,
                     l.origin, l.supplier_id, s.name AS supplier_name, l.supplier_lot, l.supplier_invoice,
                     l.originated_at, l.use_by, l.use_by_source, l.status, l.event_id, l.note`;

const LOT_FROM = `FROM lots l
                  JOIN items i ON i.id = l.item_id
             LEFT JOIN suppliers s ON s.id = l.supplier_id`;

// The balance is attached per lot rather than per lot and location here,
// because a picker asks "how much of this lot is left". Where it sits is the
// stock view below.
const LOT_BALANCE = `(SELECT COALESCE(SUM(m.quantity), 0) FROM movements m WHERE m.lot_id = l.id) AS quantity`;

export async function getLots(db, { itemId = null, status = 'open', shortCode = null } = {}) {
  const conditions = [];
  const params = [];

  if (itemId) {
    conditions.push('l.item_id = ?');
    params.push(itemId);
  }
  if (status && status !== 'all') {
    if (!['open', 'closed', 'held', 'written_off'].includes(status)) {
      throw new BadRequest(`unknown lot status: ${status}`);
    }
    conditions.push('l.status = ?');
    params.push(status);
  }
  if (shortCode) {
    conditions.push('l.short_code = ?');
    params.push(shortCode.toUpperCase());
  }

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  // First-expiring first: that is the order stock should be picked in, so it
  // is the order the picker sees without anyone having to sort it.
  const { results } = await db
    .prepare(`SELECT ${LOT_COLUMNS}, ${LOT_BALANCE} ${LOT_FROM}${where} ORDER BY l.use_by, i.name`)
    .bind(...params)
    .all();
  return results || [];
}

// Stock on hand, per lot per location. Zero balances are dropped: a lot that
// has left a freezer should not go on showing there at nothing.
export async function getStock(db, { itemId = null, locationId = null } = {}) {
  const conditions = [];
  const params = [];
  if (itemId) {
    conditions.push('l.item_id = ?');
    params.push(itemId);
  }
  if (locationId) {
    conditions.push('b.location_id = ?');
    params.push(locationId);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';

  // A movement's quantity belongs to the location it landed in when positive
  // and the one it left when negative, so the two sides of a MOVE net to zero
  // across the pair of locations rather than vanishing.
  const { results } = await db
    .prepare(
      `WITH balances AS (
         SELECT lot_id, COALESCE(to_location_id, from_location_id) AS location_id, SUM(quantity) AS quantity
           FROM movements GROUP BY lot_id, location_id
       )
       SELECT l.id AS lot_id, l.item_id, i.name AS item_name, i.base_unit, l.short_code,
              l.use_by, l.status, b.location_id, loc.name AS location_name, b.quantity
         FROM balances b
         JOIN lots l ON l.id = b.lot_id
         JOIN items i ON i.id = l.item_id
         JOIN locations loc ON loc.id = b.location_id${where}
        ${where ? 'AND' : 'WHERE'} b.quantity <> 0
        ORDER BY i.name, l.use_by`,
    )
    .bind(...params)
    .all();
  return results || [];
}

// Resolving what somebody scanned or typed. A short code identifies exactly
// one lot. A batch code is the kitchen's existing date-based number and
// routinely names several lots at once, which is why the system no longer
// joins on it — so this returns every match and says so, rather than picking
// one.
export async function lookupCode(db, code) {
  if (!code) throw new BadRequest('code is required');
  const wanted = code.trim().toUpperCase();

  const byShortCode = await getLots(db, { status: 'all', shortCode: wanted });
  if (byShortCode.length) return { code: wanted, matched: 'short_code', lots: byShortCode };

  const { results } = await db
    .prepare(`SELECT ${LOT_COLUMNS}, ${LOT_BALANCE} ${LOT_FROM} WHERE l.batch_code = ? ORDER BY l.use_by, i.name`)
    .bind(code.trim())
    .all();
  if (results && results.length) return { code: code.trim(), matched: 'batch_code', lots: results };

  return { code: wanted, matched: null, lots: [] };
}

const ACTIONS = {
  lots: (db, params) => getLots(db, params),
  stock: (db, params) => getStock(db, params),
};

export const LEDGER_ACTIONS = Object.keys(ACTIONS);

export async function handleLedger(db, url) {
  const action = url.searchParams.get('action');
  if (!action) throw new BadRequest(`action is required, one of: ${LEDGER_ACTIONS.join(', ')}`);
  const handler = ACTIONS[action];
  if (!handler) throw new BadRequest(`unknown action: ${action}`);

  const rows = await handler(db, {
    itemId: url.searchParams.get('item'),
    locationId: url.searchParams.get('location'),
    shortCode: url.searchParams.get('code'),
    status: url.searchParams.get('status') || undefined,
  });
  return { action, count: rows.length, rows };
}
