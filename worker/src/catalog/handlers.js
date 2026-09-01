import { BadRequest } from '../http.js';

// Read-only catalog reads for P0. Each returns rows in the shape the client
// asked for, with the SQLite 0/1 flags mapped to booleans so callers never
// have to remember which columns are flags.
//
// `active=all` is accepted everywhere so an admin screen can see retired rows;
// the default is active rows only, because that is what a form needs.

const BOOLEAN_COLUMNS = ['active', 'needs_health_mark'];

function toRow(row) {
  const out = { ...row };
  for (const column of BOOLEAN_COLUMNS) {
    if (out[column] === 0 || out[column] === 1) out[column] = out[column] === 1;
  }
  return out;
}

async function selectAll(db, sql, params = []) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return (results || []).map(toRow);
}

function activeClause(includeInactive, prefix = '') {
  return includeInactive ? '' : ` WHERE ${prefix}active = 1`;
}

export async function getItems(db, { kind = null, includeInactive = false } = {}) {
  const conditions = [];
  const params = [];
  if (!includeInactive) conditions.push('active = 1');
  if (kind) {
    if (!['ingredient', 'packaging', 'product'].includes(kind)) {
      throw new BadRequest(`unknown item kind: ${kind}`);
    }
    conditions.push('kind = ?');
    params.push(kind);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return selectAll(db, `SELECT * FROM items${where} ORDER BY name`, params);
}

export function getLocations(db, { includeInactive = false } = {}) {
  return selectAll(db, `SELECT * FROM locations${activeClause(includeInactive)} ORDER BY name`);
}

export function getSuppliers(db, { includeInactive = false } = {}) {
  return selectAll(db, `SELECT * FROM suppliers${activeClause(includeInactive)} ORDER BY name`);
}

export function getCustomers(db, { includeInactive = false } = {}) {
  return selectAll(db, `SELECT * FROM customers${activeClause(includeInactive)} ORDER BY name`);
}

export function getStaff(db, { includeInactive = false } = {}) {
  return selectAll(db, `SELECT * FROM staff${activeClause(includeInactive)} ORDER BY name`);
}

// The registered devices. Reference data like the rest of this file: rows are
// created by hand in the database, never by a form, so that a typo in a
// device name cannot quietly mint a second short-code pool. The intake form
// reads this to ask which of them it is running on.
export function getDevices(db, { includeInactive = false } = {}) {
  return selectAll(db, `SELECT * FROM devices${activeClause(includeInactive)} ORDER BY name`);
}

// Which supplier each ingredient comes from. Many-to-many, because the
// kitchen's own records show several items arriving from both Lynas and
// Tazaki; an item with no row here has no supplier recorded, which the intake
// form treats as "show it under every supplier" rather than "under none".
export function getItemSuppliers(db, { supplierId = null } = {}) {
  const where = supplierId ? ' WHERE s.supplier_id = ?' : '';
  return selectAll(
    db,
    `SELECT s.*, i.name AS item_name
       FROM item_suppliers s
       JOIN items i ON i.id = s.item_id${where}
      ORDER BY i.name`,
    supplierId ? [supplierId] : [],
  );
}

// The temperature limits, so the form can say "5° or below" on the field
// itself and judge a reading as it is keyed rather than after the person has
// walked away from the pallet.
export function getTemperatureLimits(db) {
  return selectAll(db, 'SELECT * FROM temperature_limits ORDER BY kind');
}

// The waste reasons staff may pick. The system's own reason for stock that
// failed a temperature check is excluded: it is written, never chosen.
export function getWasteReasons(db) {
  return selectAll(db, 'SELECT * FROM waste_reasons WHERE staff_selectable = 1 ORDER BY sort_order');
}

// What a product is made from. Returned as one row per recipe line with the
// product and the ingredient both named, because every caller is showing a
// recipe against its items rather than a set of ids.
export function getRecipes(db, { itemId = null } = {}) {
  const where = itemId ? ' WHERE r.item_id = ?' : '';
  return selectAll(
    db,
    `SELECT r.id AS recipe_id, r.item_id, p.name AS product_name, p.base_unit AS product_unit,
            r.yield_quantity, r.shelf_life_days, r.active,
            l.id AS line_id, l.item_id AS ingredient_id, i.name AS ingredient_name,
            i.base_unit AS ingredient_base_unit, i.kind AS ingredient_kind,
            i.storage_unopened, l.quantity, l.unit, l.sort_order
       FROM recipes r
       JOIN items p ON p.id = r.item_id
       JOIN recipe_lines l ON l.recipe_id = r.id
       JOIN items i ON i.id = l.item_id${where}
      ORDER BY p.name, l.sort_order`,
    itemId ? [itemId] : [],
  );
}

// Conversions are returned with the item's name attached, because every
// caller that reads a conversion is showing it against an item.
export function getConversions(db, { itemId = null } = {}) {
  const where = itemId ? ' WHERE c.item_id = ?' : '';
  return selectAll(
    db,
    `SELECT c.*, i.name AS item_name, i.base_unit
       FROM unit_conversions c
       JOIN items i ON i.id = c.item_id${where}
      ORDER BY i.name, c.from_unit`,
    itemId ? [itemId] : [],
  );
}

const ACTIONS = {
  items: (db, params) => getItems(db, params),
  locations: (db, params) => getLocations(db, params),
  suppliers: (db, params) => getSuppliers(db, params),
  customers: (db, params) => getCustomers(db, params),
  staff: (db, params) => getStaff(db, params),
  devices: (db, params) => getDevices(db, params),
  conversions: (db, params) => getConversions(db, params),
  item_suppliers: (db, params) => getItemSuppliers(db, params),
  temperature_limits: (db) => getTemperatureLimits(db),
  waste_reasons: (db) => getWasteReasons(db),
  recipes: (db, params) => getRecipes(db, params),
};

export const CATALOG_ACTIONS = Object.keys(ACTIONS);

export async function handleCatalog(db, url) {
  const action = url.searchParams.get('action');
  if (!action) throw new BadRequest(`action is required, one of: ${CATALOG_ACTIONS.join(', ')}`);
  const handler = ACTIONS[action];
  if (!handler) throw new BadRequest(`unknown action: ${action}`);

  const rows = await handler(db, {
    kind: url.searchParams.get('kind'),
    itemId: url.searchParams.get('item'),
    supplierId: url.searchParams.get('supplier'),
    includeInactive: url.searchParams.get('active') === 'all',
  });
  return { action, count: rows.length, rows };
}
