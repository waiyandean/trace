import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatch } from '../src/ledger/dispatch.js';

// A database holding one customer, two produced lots (one frozen broth, one
// ambient oil) and the temperature limits.
function dispatchDb(overrides = {}) {
  const state = {
    balances: { 'lot:broth@loc:freezer': 40, 'lot:oil@loc:dry': 12 },
    holds: { temperature: 0, manual: 0 },
    customers: { 'cust:jfc': { id: 'cust:jfc', name: 'JFC', active: 1 } },
    staff: { 'staff:nikin': { id: 'staff:nikin', name: 'Nikin', active: 1 } },
    locations: {
      'loc:freezer': { id: 'loc:freezer', name: 'Walk In Freezer', active: 1 },
      'loc:dry': { id: 'loc:dry', name: 'Dry Store', active: 1 },
    },
    lots: {
      'lot:broth': {
        id: 'lot:broth', status: 'open', origin: 'produced', use_by: '2027-09-01',
        use_by_source: 'shelf_life_rule', item_id: 'item:broth', item_name: 'Tonkotsu Broth',
        base_unit: 'L', kind: 'product', storage_unopened: 'freezer',
      },
      'lot:oil': {
        id: 'lot:oil', status: 'open', origin: 'produced', use_by: '2027-03-01',
        use_by_source: 'shelf_life_rule', item_id: 'item:oil', item_name: 'Chilli Oil',
        base_unit: 'L', kind: 'product', storage_unopened: 'ambient',
      },
      'lot:carcass': {
        id: 'lot:carcass', status: 'open', origin: 'received', use_by: '2026-09-10',
        use_by_source: 'supplier_printed', item_id: 'item:carcass', item_name: 'Chicken Carcass',
        base_unit: 'kg', kind: 'ingredient', storage_unopened: 'freezer',
      },
    },
    events: {},
    ...overrides,
  };

  const written = [];
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
          if (sql.includes('FROM events')) return state.events[id] ?? null;
          if (sql.includes('FROM staff')) return state.staff[id] ?? null;
          if (sql.includes('FROM customers WHERE id')) return state.customers[id] ?? null;
          if (sql.includes('FROM lots l JOIN items')) return state.lots[id] ?? null;
          if (sql.includes('FROM locations')) return state.locations[id] ?? null;
          if (sql.includes('FROM dispatches')) return { event_id: id, customer_name: 'JFC' };
          return null;
        },
        async all() {
          if (sql.includes('FROM temperature_limits')) {
            return { results: [{ kind: 'chilled', celsius: 5 }, { kind: 'frozen', celsius: -18 }] };
          }
          return { results: [] };
        },
      };
      return statement;
    },
  };
}

const note = (changes = {}) => ({
  event_id: '01J8XQZ5T7M4QPB9CDEFGHJKMP',
  idempotency_key: 'dispatch-0001',
  staff_id: 'staff:nikin',
  occurred_at: '2026-09-04T09:00:00Z',
  customer_id: 'cust:jfc',
  vehicle_condition: 'good',
  vehicle_frozen_c: -20,
  lines: [{ lot_id: 'lot:broth', location_id: 'loc:freezer', quantity: 12, unit: 'L' }],
  ...changes,
});

const sqlOf = (db, fragment) => db.written.filter((statement) => statement.sql.includes(fragment));

test('a dispatch writes one negative DISPATCH movement per line', async () => {
  const db = dispatchDb();
  await dispatch(db, note());
  const movements = sqlOf(db, 'INSERT INTO movements');
  assert.equal(movements.length, 1);
  assert.equal(movements[0].sql.includes("'DISPATCH'"), true);
  assert.equal(movements[0].params[2], -12, 'signed negative, leaving the building');
  assert.equal(movements[0].params[5], 'loc:freezer', 'from the location it left');
});

test('the customer and the paper reference are recorded once for the load', async () => {
  const db = dispatchDb();
  await dispatch(db, note({ reference: 'PO-5567' }));
  const row = sqlOf(db, 'INSERT INTO dispatches')[0].params;
  assert.equal(row[1], 'cust:jfc');
  assert.equal(row[2], 'PO-5567');
  assert.equal(row[3], 'good');
});

test('only produced stock can be dispatched', async () => {
  const db = dispatchDb();
  await assert.rejects(
    () => dispatch(db, note({ lines: [{ lot_id: 'lot:carcass', location_id: 'loc:freezer', quantity: 5, unit: 'kg' }] })),
    /came from a delivery, not a batch/,
  );
});

test('more cannot be dispatched than is at that location', async () => {
  const db = dispatchDb({ balances: { 'lot:broth@loc:freezer': 8 } });
  await assert.rejects(() => dispatch(db, note()), /only 8 L of Tonkotsu Broth is in Walk In Freezer/);
});

test('a held lot cannot be dispatched', async () => {
  for (const holds of [{ temperature: 1, manual: 0 }, { temperature: 0, manual: 1 }]) {
    const db = dispatchDb({ holds });
    await assert.rejects(() => dispatch(db, note()), /is held and cannot be dispatched/);
  }
});

test('a frozen load needs the van frozen temperature', async () => {
  const db = dispatchDb();
  const payload = note();
  delete payload.vehicle_frozen_c;
  await assert.rejects(() => dispatch(db, payload), /vehicle_frozen_c is required: this dispatch contains frozen stock/);
});

test('a warm van stops the load rather than sending it', async () => {
  const db = dispatchDb();
  await assert.rejects(
    () => dispatch(db, note({ vehicle_frozen_c: -10 })),
    /van's frozen temperature of -10°C is above the -18°C limit/,
  );
});

test('a reading for a class the load does not carry is refused', async () => {
  const db = dispatchDb();
  await assert.rejects(
    () => dispatch(db, note({
      vehicle_chilled_c: 4,
      lines: [{ lot_id: 'lot:oil', location_id: 'loc:dry', quantity: 3, unit: 'L' }],
      vehicle_frozen_c: undefined,
    })),
    /vehicle_chilled_c was given but this dispatch contains no chilled stock/,
  );
});

test('an ambient-only load needs no van temperature at all', async () => {
  const db = dispatchDb();
  await dispatch(db, note({
    vehicle_frozen_c: undefined,
    lines: [{ lot_id: 'lot:oil', location_id: 'loc:dry', quantity: 3, unit: 'L' }],
  }));
  assert.equal(sqlOf(db, 'INSERT INTO temperature_readings').length, 0);
  assert.equal(sqlOf(db, 'INSERT INTO movements').length, 1);
});

test('a passing van reading is written as evidence the check was made', async () => {
  const db = dispatchDb();
  await dispatch(db, note());
  const readings = sqlOf(db, 'INSERT INTO temperature_readings');
  assert.equal(readings.length, 1);
  assert.equal(readings[0].params[3], 'vehicle_frozen');
  assert.equal(readings[0].sql.includes('within_limit, staff_id'), true);
});

test('the same lot from the same place twice is a slip, not two lines', async () => {
  const db = dispatchDb();
  const payload = note();
  payload.lines.push({ ...payload.lines[0] });
  await assert.rejects(() => dispatch(db, payload), /listed twice from the same place/);
});

test('an unknown customer is refused', async () => {
  const db = dispatchDb();
  await assert.rejects(() => dispatch(db, note({ customer_id: 'cust:nobody' })), /unknown customer/);
});

test('a dispatch of nothing is not a dispatch', async () => {
  const db = dispatchDb();
  await assert.rejects(() => dispatch(db, note({ lines: [] })), /non-empty array/);
});

test('the idempotency key cannot be reused for a different submission', async () => {
  const db = dispatchDb({
    events: { 'dispatch-0001': { id: 'evt:earlier', payload_hash: 'a-different-payload' } },
  });
  await assert.rejects(() => dispatch(db, note()), /was already used for a different submission/);
});

test('the use-by is passed through from the lot, never entered or recomputed', async () => {
  // Read straight off lots in the result; dispatch.js has no date arithmetic.
  const src = readFileSync(new URL('../src/ledger/dispatch.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /deriveUseBy|setUTCDate|shelf_life/);
  assert.match(src, /l\.use_by, l\.use_by_source/);
});
