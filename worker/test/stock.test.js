import test from 'node:test';
import assert from 'node:assert/strict';
import { move, waste, hold } from '../src/ledger/stock.js';

// A database holding one lot with stock in one place, so the rule underneath
// all of P2 can be tested: a balance may never go below zero.
function stockDb(overrides = {}) {
  const state = {
    balance: 24,
    holds: { temperature: 0, manual: 0 },
    lot: { id: 'lot1', status: 'open', short_code: 'K7M4QP', item_name: 'Chicken Carcass', base_unit: 'kg' },
    locations: {
      'loc:freezer': { id: 'loc:freezer', name: 'Walk In Freezer', active: 1 },
      'loc:fridge': { id: 'loc:fridge', name: 'Walk In Fridge', active: 1 },
      'loc:retired': { id: 'loc:retired', name: 'Old Shed', active: 0 },
    },
    staff: { 'staff:nikin': { id: 'staff:nikin', name: 'Nikin', active: 1 } },
    devices: { 'dev:ipad': { id: 'dev:ipad', active: 1 } },
    reasons: {
      'waste:damaged': { id: 'waste:damaged', name: 'Damaged or spoiled', staff_selectable: 1 },
      'waste:temperature': { id: 'waste:temperature', name: 'Failed a temperature check', staff_selectable: 0 },
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
          const [id] = statement.params;
          if (sql.includes('SUM(quantity)')) return { quantity: state.balance };
          if (sql.includes('FROM temperature_deviations')) return { n: state.holds.temperature };
          if (sql.includes('FROM holds')) return { n: state.holds.manual };
          if (sql.includes('FROM lots l JOIN items')) return id === state.lot.id ? state.lot : null;
          if (sql.includes('FROM locations')) return state.locations[id] ?? null;
          if (sql.includes('FROM staff')) return state.staff[id] ?? null;
          if (sql.includes('FROM devices')) return state.devices[id] ?? null;
          if (sql.includes('FROM waste_reasons')) return state.reasons[id] ?? null;
          if (sql.includes('FROM events')) return state.events[id] ?? null;
          if (sql.includes('FROM lots WHERE id')) return { id: state.lot.id, status: state.lot.status };
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
  };
}

const ULID = '01J8XQZ5T7M4QPB9CDEFGHJKMN';
const envelope = (changes = {}) => ({
  event_id: ULID,
  idempotency_key: 'stock-0001',
  device_id: 'dev:ipad',
  staff_id: 'staff:nikin',
  occurred_at: '2026-10-01T09:00:00Z',
  ...changes,
});

const moving = (changes = {}) =>
  envelope({ lot_id: 'lot1', quantity: 8, from_location_id: 'loc:freezer', to_location_id: 'loc:fridge', ...changes });

const sqlOf = (db, fragment) => db.written.filter((statement) => statement.sql.includes(fragment));

test('a move writes two rows: out of one place and into the other', async () => {
  const db = stockDb();
  await move(db, moving());

  const movements = sqlOf(db, 'INSERT INTO movements');
  assert.equal(movements.length, 2);
  // Two rows rather than one with a from and a to, so a reader that looks at
  // only one column cannot half-apply it.
  assert.deepEqual(movements.map((row) => row.params[2]), [-8, 8]);
  assert.equal(movements[0].params[3], 'loc:freezer');
  assert.equal(movements[1].params[3], 'loc:fridge');
});

test('stock that is not there cannot be moved', async () => {
  const db = stockDb({ balance: 5 });
  await assert.rejects(() => move(db, moving()), /only 5 kg of Chicken Carcass is in Walk In Freezer/);
});

test('a location with nothing in it says so rather than going negative', async () => {
  const db = stockDb({ balance: 0 });
  await assert.rejects(() => move(db, moving()), /there is no Chicken Carcass from that lot in Walk In Freezer/);
});

test('stock cannot be moved to where it already is', async () => {
  const db = stockDb();
  await assert.rejects(() => move(db, moving({ to_location_id: 'loc:freezer' })), /two different places/);
});

test('a retired location is not somewhere stock can go', async () => {
  const db = stockDb();
  await assert.rejects(() => move(db, moving({ to_location_id: 'loc:retired' })), /Old Shed is not an active location/);
});

test('held stock stays where it is', async () => {
  // Moving held stock is how it quietly ends up back in the usable racking.
  for (const holds of [{ temperature: 1, manual: 0 }, { temperature: 0, manual: 1 }]) {
    const db = stockDb({ holds });
    await assert.rejects(() => move(db, moving()), /is held and cannot be moved/);
  }
});

test('waste takes the stock off the balance and names why', async () => {
  const db = stockDb();
  await waste(db, envelope({ lot_id: 'lot1', quantity: 3, location_id: 'loc:freezer', reason_id: 'waste:damaged' }));

  const movements = sqlOf(db, 'INSERT INTO movements');
  assert.equal(movements.length, 1);
  assert.equal(movements[0].params[2], -3);
  assert.equal(movements[0].params[7], 'waste:damaged');
});

test('waste needs a reason the catalog knows', async () => {
  const db = stockDb();
  await assert.rejects(
    () => waste(db, envelope({ lot_id: 'lot1', quantity: 3, location_id: 'loc:freezer', reason_id: 'waste:nope' })),
    /unknown waste reason/,
  );
});

test("the system's own reason cannot be chosen by a person", async () => {
  const db = stockDb();
  await assert.rejects(
    () => waste(db, envelope({ lot_id: 'lot1', quantity: 3, location_id: 'loc:freezer', reason_id: 'waste:temperature' })),
    /written by the system, not chosen/,
  );
});

test('more cannot be thrown away than is there', async () => {
  const db = stockDb({ balance: 2 });
  await assert.rejects(
    () => waste(db, envelope({ lot_id: 'lot1', quantity: 3, location_id: 'loc:freezer', reason_id: 'waste:damaged' })),
    /and 3 cannot be thrown away/,
  );
});

test('a hold needs a reason somebody else can act on', async () => {
  const db = stockDb();
  await assert.rejects(() => hold(db, envelope({ lot_id: 'lot1', reason: 'no' })), /a hold needs a reason/);
  await assert.rejects(() => hold(db, envelope({ lot_id: 'lot1' })), /a hold needs a reason/);
});

test('a hold marks the lot held', async () => {
  const db = stockDb();
  await hold(db, envelope({ lot_id: 'lot1', reason: 'supplier recall notice' }));
  assert.equal(sqlOf(db, 'INSERT INTO holds').length, 1);
  assert.match(sqlOf(db, 'UPDATE lots')[0].sql, /status = 'held'/);
});

test('a resent submission writes nothing a second time', async () => {
  const db = stockDb();
  db.state.events['stock-0001'] = { id: ULID, payload_hash: 'whatever' };
  // The hash will not match this payload, which is the reused-key case.
  await assert.rejects(() => move(db, moving()), /already used for a different submission/);
});

test('a quantity of zero or less is not a movement', async () => {
  const db = stockDb();
  await assert.rejects(() => move(db, moving({ quantity: 0 })), /must be a positive number/);
  await assert.rejects(() => move(db, moving({ quantity: -4 })), /must be a positive number/);
});
