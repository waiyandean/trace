import test from 'node:test';
import assert from 'node:assert/strict';
import { receive, deriveUseBy, payloadHash } from '../src/ledger/receive.js';

// A stand-in database holding one delivery's worth of catalog, so a
// submission can be followed all the way to the statements it would write
// without needing D1. Everything the endpoint reads is answered from here;
// everything it writes lands in `written`.
function intakeDb(overrides = {}) {
  const state = {
    items: { 'item:carcass': { id: 'item:carcass', name: 'Chicken Carcass', base_unit: 'kg', shelf_life_days: 7, active: 1 } },
    locations: { 'loc:fridge': { id: 'loc:fridge', name: 'Walk In Fridge', active: 1 } },
    staff: { 'staff:nikin': { id: 'staff:nikin', name: 'Nikin', active: 1 } },
    devices: { 'dev:ipad': { id: 'dev:ipad', active: 1 } },
    suppliers: { 'sup:lynas': { id: 'sup:lynas', name: 'Lynas', active: 1 } },
    conversions: [{ id: 'c1', from_unit: 'case', to_unit: 'kg', factor: 8 }],
    events: {},
    lots: {},
    shortCodes: { K7M4QP: { code: 'K7M4QP', device_id: 'dev:ipad', lot_id: null } },
    ...overrides,
  };

  const written = [];
  const answer = (sql, params) => {
    if (sql.includes('FROM items')) return state.items[params[0]] ?? null;
    if (sql.includes('FROM locations')) return state.locations[params[0]] ?? null;
    if (sql.includes('FROM staff')) return state.staff[params[0]] ?? null;
    if (sql.includes('FROM devices')) return state.devices[params[0]] ?? null;
    if (sql.includes('FROM suppliers')) return state.suppliers[params[0]] ?? null;
    if (sql.includes('FROM short_codes')) return state.shortCodes[params[0]] ?? null;
    if (sql.includes('FROM lots WHERE id')) return state.lots[params[0]] ?? null;
    if (sql.includes('FROM events')) return state.events[params[0]] ?? null;
    return null;
  };

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
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async first() {
          return answer(sql, statement.params);
        },
        async all() {
          if (sql.includes('FROM unit_conversions')) return { results: state.conversions };
          return { results: [] };
        },
        sql,
      };
      return statement;
    },
  };
}

const LOT = '01J8XQZ5T7M4QPB9CDEFGHJKMN';
const EVENT = '01J8XQZ5T7M4QPB9CDEFGHJKMP';

const delivery = (changes = {}) => ({
  event_id: EVENT,
  idempotency_key: 'goods-in-0001',
  device_id: 'dev:ipad',
  staff_id: 'staff:nikin',
  occurred_at: '2026-08-31T09:14:00Z',
  supplier_id: 'sup:lynas',
  invoice: '009298395',
  lines: [
    {
      lot_id: LOT,
      item_id: 'item:carcass',
      short_code: 'K7M4QP',
      quantity: 3,
      unit: 'case',
      location_id: 'loc:fridge',
      use_by: '2026-09-04',
      batch_code: '2026-08-31',
    },
  ],
  ...changes,
});

const sqlOf = (db, fragment) => db.written.filter((statement) => statement.sql.includes(fragment));

// The lot insert's bindings, named, so a test reads as what it means rather
// than as a list of positions that shift whenever a column is added.
const LOT_BINDINGS = [
  'id', 'item_id', 'short_code', 'batch_code', 'supplier_id', 'supplier_lot',
  'supplier_invoice', 'originated_at', 'use_by', 'use_by_source', 'event_id', 'note',
];

function lotFields(db, index = 0) {
  const { params } = sqlOf(db, 'INSERT INTO lots')[index];
  return Object.fromEntries(LOT_BINDINGS.map((name, i) => [name, params[i]]));
}

test('a delivery line opens a lot and writes one RECEIVE movement', async () => {
  const db = intakeDb();
  await receive(db, delivery());

  assert.equal(sqlOf(db, 'INSERT INTO events').length, 1);
  assert.equal(sqlOf(db, 'INSERT INTO lots').length, 1);
  const movements = sqlOf(db, 'INSERT INTO movements');
  assert.equal(movements.length, 1);

  // Three cases at eight kilograms a case, recorded in the item's base unit
  // with what the person actually keyed kept beside it.
  const [, , quantity, enteredQuantity, enteredUnit] = movements[0].params;
  assert.equal(quantity, 24);
  assert.equal(enteredQuantity, 3);
  assert.equal(enteredUnit, 'case');
});

test('the short code is bound from the same transaction as the lot', async () => {
  const db = intakeDb();
  await receive(db, delivery());
  const binding = sqlOf(db, 'UPDATE short_codes');
  assert.equal(binding.length, 1);
  assert.deepEqual(binding[0].params, [LOT, 'K7M4QP']);
});

test('a lot with no code is still booked: a dry pool delays the label, not the delivery', async () => {
  const db = intakeDb();
  const payload = delivery();
  delete payload.lines[0].short_code;
  await receive(db, payload);

  assert.equal(sqlOf(db, 'UPDATE short_codes').length, 0);
  assert.equal(lotFields(db).short_code, null, 'the lot carries no short code');
  assert.equal(sqlOf(db, 'INSERT INTO movements').length, 1);
});

test("the supplier's printed date wins and is recorded as theirs", async () => {
  const db = intakeDb();
  await receive(db, delivery());
  const lot = lotFields(db);
  assert.equal(lot.use_by, '2026-09-04');
  assert.equal(lot.use_by_source, 'supplier_printed');
});

test('with no printed date the shelf-life rule fills in, and says so', async () => {
  const db = intakeDb();
  const payload = delivery();
  delete payload.lines[0].use_by;
  await receive(db, payload);
  const lot = lotFields(db);
  assert.equal(lot.use_by, '2026-09-07', 'seven days from the day it arrived');
  assert.equal(lot.use_by_source, 'shelf_life_rule');
});

test('the payload is stored verbatim as the evidence of what was submitted', async () => {
  const db = intakeDb();
  const payload = delivery();
  await receive(db, payload);
  const stored = sqlOf(db, 'INSERT INTO events')[0].params.at(-1);
  assert.deepEqual(JSON.parse(stored), payload);
});

test('a resend of an accepted submission writes nothing and reports the duplicate', async () => {
  const db = intakeDb();
  const payload = delivery();
  db.state.events['goods-in-0001'] = { id: EVENT, payload_hash: await payloadHash(payload) };

  const result = await receive(db, payload);
  assert.equal(result.duplicate, true);
  assert.equal(db.written.length, 0, 'nothing was written a second time');
});

test('the same key on different content is refused rather than swallowed', async () => {
  const db = intakeDb();
  db.state.events['goods-in-0001'] = { id: EVENT, payload_hash: 'a-different-submission' };
  await assert.rejects(() => receive(db, delivery()), /already used for a different submission/);
});

test('a lot id that already exists is refused and names the earlier event', async () => {
  const db = intakeDb();
  db.state.lots[LOT] = { id: LOT, event_id: 'earlier-event' };
  await assert.rejects(() => receive(db, delivery({ idempotency_key: 'goods-in-0002' })), /already exists, booked by event earlier-event/);
});

test('a code belonging to another device is refused', async () => {
  const db = intakeDb();
  db.state.shortCodes.K7M4QP.device_id = 'dev:other';
  await assert.rejects(() => receive(db, delivery()), /belongs to another device/);
});

test('a code that was never issued is refused', async () => {
  const db = intakeDb();
  delete db.state.shortCodes.K7M4QP;
  await assert.rejects(() => receive(db, delivery()), /was never issued/);
});

test('an inactive item cannot be received against', async () => {
  const db = intakeDb();
  db.state.items['item:carcass'].active = 0;
  await assert.rejects(() => receive(db, delivery()), /is not an active item/);
});

test('a lot id that is not a device-minted ULID is refused', async () => {
  const db = intakeDb();
  const payload = delivery();
  payload.lines[0].lot_id = 'lot-1';
  await assert.rejects(() => receive(db, payload), /must be a ULID/);
});

test('a delivery with no lines is not a delivery', async () => {
  const db = intakeDb();
  await assert.rejects(() => receive(db, delivery({ lines: [] })), /non-empty array/);
});

test('two lines cannot claim the same code', async () => {
  const db = intakeDb();
  const payload = delivery();
  payload.lines.push({ ...payload.lines[0], lot_id: '01J8XQZ5T7M4QPB9CDEFGHJKMQ' });
  await assert.rejects(() => receive(db, payload), /same short code/);
});

test('the shelf-life fallback counts whole days from the day of arrival', () => {
  assert.equal(deriveUseBy('2026-08-31T23:50:00Z', 7), '2026-09-07');
  assert.equal(deriveUseBy('2026-12-30T09:00:00Z', 7), '2027-01-06');
});

test('the payload fingerprint ignores key order but not content', async () => {
  const a = await payloadHash({ b: 2, a: 1, lines: [{ y: 1, x: 2 }] });
  const b = await payloadHash({ a: 1, lines: [{ x: 2, y: 1 }], b: 2 });
  const c = await payloadHash({ a: 1, lines: [{ x: 2, y: 9 }], b: 2 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
