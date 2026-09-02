import test from 'node:test';
import assert from 'node:assert/strict';
import { produce, deriveUseBy } from '../src/ledger/produce.js';

// A database holding one product with a recipe and two lots of one ingredient,
// which is what a split allocation needs.
function batchDb(overrides = {}) {
  const state = {
    balances: { 'lot:a@loc:freezer': 24, 'lot:b@loc:freezer': 16 },
    holds: { temperature: 0, manual: 0 },
    items: {
      'item:broth': { id: 'item:broth', name: 'Chicken Broth', base_unit: 'L', kind: 'product', active: 1 },
      'item:carcass': { id: 'item:carcass', name: 'Chicken Carcass', base_unit: 'kg', kind: 'ingredient', active: 1 },
      'item:wings': { id: 'item:wings', name: 'Chicken Wings', base_unit: 'kg', kind: 'ingredient', active: 1 },
    },
    lots: {
      'lot:a': { id: 'lot:a', status: 'open', item_id: 'item:carcass', item_name: 'Chicken Carcass', base_unit: 'kg' },
      'lot:b': { id: 'lot:b', status: 'open', item_id: 'item:carcass', item_name: 'Chicken Carcass', base_unit: 'kg' },
    },
    locations: { 'loc:freezer': { id: 'loc:freezer', name: 'Walk In Freezer', active: 1 } },
    staff: { 'staff:nikin': { id: 'staff:nikin', name: 'Nikin', active: 1 } },
    recipe: { id: 'recipe:broth', shelf_life_days: 360 },
    events: {},
    ...overrides,
  };

  const written = [];
  let lastLocation = null;
  return {
    state,
    written,
    async batch(statements) {
      written.push(...statements);
      return statements.map(() => ({ success: true }));
    },
    prepare(sql) {
      const statement = {
        params: [],
        sql,
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async first() {
          const [id, second] = statement.params;
          if (sql.includes('SUM(quantity)')) return { quantity: state.balances[`${id}@${second}`] ?? 0 };
          if (sql.includes('FROM temperature_deviations')) return { n: state.holds.temperature };
          if (sql.includes('FROM holds')) return { n: state.holds.manual };
          if (sql.includes('FROM recipes')) return state.recipe;
          if (sql.includes('FROM lots l JOIN items')) return state.lots[id] ?? null;
          if (sql.includes('FROM lots WHERE id')) return state.lots[id] ?? null;
          if (sql.includes('FROM locations')) return state.locations[id] ?? null;
          if (sql.includes('FROM staff')) return state.staff[id] ?? null;
          if (sql.includes('FROM events')) return state.events[id] ?? null;
          if (sql.includes('FROM items')) return state.items[id] ?? null;
          return null;
        },
        async all() {
          if (sql.includes('FROM unit_conversions')) return { results: [] };
          return { results: [] };
        },
      };
      return statement;
    },
  };
}

const LOT = '01J8XQZ5T7M4QPB9CDEFGHJKMN';
const batch = (changes = {}) => ({
  event_id: '01J8XQZ5T7M4QPB9CDEFGHJKMP',
  idempotency_key: 'batch-0001',
  staff_id: 'staff:nikin',
  occurred_at: '2026-09-02T08:00:00Z',
  lot_id: LOT,
  item_id: 'item:broth',
  location_id: 'loc:freezer',
  yield_quantity: 200,
  yield_unit: 'L',
  lines: [
    {
      item_id: 'item:carcass',
      allocations: [
        { lot_id: 'lot:a', location_id: 'loc:freezer', quantity: 16, unit: 'kg' },
        { lot_id: 'lot:b', location_id: 'loc:freezer', quantity: 14, unit: 'kg' },
      ],
    },
  ],
  ...changes,
});

const sqlOf = (db, fragment) => db.written.filter((statement) => statement.sql.includes(fragment));

// Named rather than indexed, so a test reads as what it means and does not
// shift when a column is added.
const named = (bindings) => (statement) =>
  Object.fromEntries(bindings.map((name, i) => [name, statement.params[i]]));

const lotFields = named([
  'id', 'item_id', 'short_code', 'batch_code', 'originated_at',
  'use_by', 'use_by_source', 'event_id', 'note',
]);
const consumeFields = named([
  'id', 'lot_id', 'quantity', 'entered_quantity', 'entered_unit',
  'from_location_id', 'counterpart_lot_id', 'occurred_at', 'staff_id', 'event_id',
]);

test('a batch opens a lot of the product and consumes from the lots named', async () => {
  const db = batchDb();
  await produce(db, batch());

  assert.equal(sqlOf(db, 'INSERT INTO lots').length, 1);
  const movements = sqlOf(db, 'INSERT INTO movements');
  assert.equal(movements.length, 3, 'one produce and two consumes');
  assert.equal(movements[0].params[2], 200, 'the yield is positive');
  assert.deepEqual(movements.slice(1).map((row) => row.params[2]), [-16, -14], 'the inputs are negative');
});

test('an ingredient may be drawn from more than one lot', async () => {
  // Half a batch from one case and half from another is the ordinary case.
  const db = batchDb();
  await produce(db, batch());
  const consumes = sqlOf(db, "'CONSUME'");
  assert.deepEqual(consumes.map((row) => row.params[1]), ['lot:a', 'lot:b']);
});

test('every consuming movement names the lot it fed, which is the genealogy', async () => {
  const db = batchDb();
  await produce(db, batch());
  for (const row of sqlOf(db, "'CONSUME'")) {
    assert.equal(consumeFields(row).counterpart_lot_id, LOT, 'counterpart is the batch');
  }
});

test('the use-by comes from the recipe, not from the form', async () => {
  const db = batchDb();
  await produce(db, batch());
  const lot = lotFields(sqlOf(db, 'INSERT INTO lots')[0]);
  assert.equal(lot.use_by, '2027-08-28', '360 days from the day it was made');
  assert.equal(lot.use_by_source, 'shelf_life_rule');
});

test('a product whose recipe states no shelf life gets no use-by rather than a guessed one', async () => {
  const db = batchDb({ recipe: { id: 'recipe:broth', shelf_life_days: null } });
  await produce(db, batch());
  const lot = lotFields(sqlOf(db, 'INSERT INTO lots')[0]);
  assert.equal(lot.use_by, null);
  assert.equal(lot.use_by_source, null);
});

test('more cannot be taken from a lot than is in that place', async () => {
  const db = batchDb({ balances: { 'lot:a@loc:freezer': 5 } });
  await assert.rejects(() => produce(db, batch()), /only 5 kg of Chicken Carcass is in Walk In Freezer/);
});

test('held stock cannot go into a batch', async () => {
  for (const holds of [{ temperature: 1, manual: 0 }, { temperature: 0, manual: 1 }]) {
    const db = batchDb({ holds });
    await assert.rejects(() => produce(db, batch()), /is held and cannot be used in a batch/);
  }
});

test('a lot of the wrong ingredient is refused', async () => {
  const db = batchDb();
  const payload = batch();
  payload.lines[0].item_id = 'item:wings';
  await assert.rejects(() => produce(db, payload), /that lot is Chicken Carcass, not Chicken Wings/);
});

test('the same lot twice from the same place is a slip, not a split', async () => {
  const db = batchDb();
  const payload = batch();
  payload.lines[0].allocations[1] = { ...payload.lines[0].allocations[0] };
  await assert.rejects(() => produce(db, payload), /listed twice from the same place/);
});

test('an ingredient with no identified lot is recorded rather than blocking the batch', async () => {
  // The kitchen's answer: a blocked batch with a pot on the heat gets worked
  // around, and the way around it is a plausible wrong lot.
  const db = batchDb();
  const payload = batch();
  payload.lines.push({
    item_id: 'item:wings',
    unproven: { quantity: 12, unit: 'kg', reason: 'case had no label' },
  });

  await produce(db, payload);
  const unproven = sqlOf(db, 'INSERT INTO unproven_inputs');
  assert.equal(unproven.length, 1);
  assert.equal(unproven[0].params[3], 'item:wings');
  assert.equal(unproven[0].params[6], 'case had no label');
});

test('an unproven ingredient still needs a reason', async () => {
  const db = batchDb();
  const payload = batch();
  payload.lines.push({ item_id: 'item:wings', unproven: { quantity: 12, unit: 'kg', reason: 'x' } });
  await assert.rejects(() => produce(db, payload), /needs a reason/);
});

test('a line that names neither lots nor a reason is refused', async () => {
  const db = batchDb();
  const payload = batch();
  payload.lines.push({ item_id: 'item:wings' });
  await assert.rejects(() => produce(db, payload), /name the lots this came from/);
});

test('a batch made from nothing is not a batch', async () => {
  const db = batchDb();
  await assert.rejects(() => produce(db, batch({ lines: [] })), /non-empty array/);
});

test('an ingredient cannot be produced as though it were a product', async () => {
  const db = batchDb();
  await assert.rejects(() => produce(db, batch({ item_id: 'item:carcass' })), /is not a product/);
});

test('the shelf life counts whole days from the day it was made', () => {
  assert.equal(deriveUseBy('2026-09-02T23:50:00Z', 180), '2027-03-01');
  assert.equal(deriveUseBy('2026-09-02T08:00:00Z', 360), '2027-08-28');
});
