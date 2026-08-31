import test from 'node:test';
import assert from 'node:assert/strict';
import { receive, deriveUseBy, payloadHash } from '../src/ledger/receive.js';

// A stand-in database holding one delivery's worth of catalog, so a
// submission can be followed all the way to the statements it would write
// without needing D1. Everything the endpoint reads is answered from here;
// everything it writes lands in `written`.
function intakeDb(overrides = {}) {
  const state = {
    items: {
      'item:carcass': {
        id: 'item:carcass', name: 'Chicken Carcass', base_unit: 'kg',
        shelf_life_days: 7, storage_unopened: 'freezer', active: 1,
      },
      'item:oil': {
        id: 'item:oil', name: 'Rapeseed Oil', base_unit: 'L',
        shelf_life_days: 7, storage_unopened: 'ambient', active: 1,
      },
    },
    locations: { 'loc:fridge': { id: 'loc:fridge', name: 'Walk In Fridge', active: 1 } },
    staff: { 'staff:nikin': { id: 'staff:nikin', name: 'Nikin', active: 1 } },
    devices: { 'dev:ipad': { id: 'dev:ipad', active: 1 } },
    suppliers: { 'sup:lynas': { id: 'sup:lynas', name: 'Lynas', active: 1 } },
    conversions: [{ id: 'c1', from_unit: 'case', to_unit: 'kg', factor: 8 }],
    limits: [{ kind: 'chilled', celsius: 5 }, { kind: 'frozen', celsius: -18 }],
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
          if (sql.includes('FROM temperature_limits')) return { results: state.limits };
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
  // Every delivery carries its checks. A frozen delivery needs the van's
  // frozen reading and a probe per line, which is why they are in the fixture
  // rather than bolted onto the one test that looks at them.
  checks: {
    vehicle_condition: 'good',
    condition_ok: true,
    labels_applied: true,
    allergens_confirmed: true,
    vehicle_frozen_c: -20,
  },
  lines: [
    {
      lot_id: LOT,
      item_id: 'item:carcass',
      short_code: 'K7M4QP',
      quantity: 3,
      unit: 'case',
      location_id: 'loc:fridge',
      use_by: '2026-09-04',
      batch_code: '310826',
      product_temp_c: -19,
    },
  ],
  ...changes,
});

const sqlOf = (db, fragment) => db.written.filter((statement) => statement.sql.includes(fragment));

// The lot insert's bindings, named, so a test reads as what it means rather
// than as a list of positions that shift whenever a column is added.
const LOT_BINDINGS = [
  'id', 'item_id', 'short_code', 'batch_code', 'supplier_id', 'supplier_lot',
  'supplier_invoice', 'originated_at', 'use_by', 'use_by_source', 'status', 'event_id', 'note',
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

test('the same ingredient twice with different use-by dates becomes two lots', async () => {
  // The case that matters at the door: part of a delivery is dated further
  // out than the rest. Each gets its own lot, its own code and its own
  // use-by, so the earlier-expiring stock can be picked first later.
  const db = intakeDb();
  const payload = delivery();
  payload.lines.push({
    ...payload.lines[0],
    lot_id: '01J8XQZ5T7M4QPB9CDEFGHJKMQ',
    short_code: 'K9NR2T',
    use_by: '2026-09-11',
  });
  db.state.shortCodes.K9NR2T = { code: 'K9NR2T', device_id: 'dev:ipad', lot_id: null };

  await receive(db, payload);

  const lots = sqlOf(db, 'INSERT INTO lots');
  assert.equal(lots.length, 2);

  const first = lotFields(db, 0);
  const second = lotFields(db, 1);
  assert.equal(first.item_id, second.item_id, 'the same ingredient');
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.short_code, second.short_code);
  assert.deepEqual([first.use_by, second.use_by], ['2026-09-04', '2026-09-11']);
  assert.equal(first.batch_code, second.batch_code, 'one delivery, one batch number');

  assert.equal(sqlOf(db, 'UPDATE short_codes').length, 2, 'both codes are bound');
  assert.equal(sqlOf(db, 'INSERT INTO movements').length, 2);
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

// The checks are what make a booked-in delivery a compliance record rather
// than just a traceability one, so their absence is a refusal.

test('a delivery with no checks is refused', async () => {
  const db = intakeDb();
  const payload = delivery();
  delete payload.checks;
  await assert.rejects(() => receive(db, payload), /checks are required/);
});

test('an attestation cannot be left out', async () => {
  const db = intakeDb();
  const payload = delivery();
  delete payload.checks.allergens_confirmed;
  await assert.rejects(() => receive(db, payload), /allergens_confirmed must be true or false/);
});

test('the checks are written against the delivery', async () => {
  const db = intakeDb();
  await receive(db, delivery());
  const checks = sqlOf(db, 'INSERT INTO delivery_checks');
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].params.slice(1, 6), ['good', null, 1, 1, 1]);
});

test('a frozen line with no probe reading is refused', async () => {
  const db = intakeDb();
  const payload = delivery();
  delete payload.lines[0].product_temp_c;
  await assert.rejects(() => receive(db, payload), /needs a product temperature/);
});

test('an ambient line is not asked for a reading, and refuses one', async () => {
  const db = intakeDb();
  const payload = delivery();
  payload.lines[0].item_id = 'item:oil';
  delete payload.checks.vehicle_frozen_c;
  delete payload.lines[0].product_temp_c;
  payload.lines[0].unit = 'L';
  await receive(db, payload);
  assert.equal(sqlOf(db, 'INSERT INTO temperature_readings').length, 0);

  const withReading = intakeDb();
  const other = delivery();
  other.lines[0].item_id = 'item:oil';
  other.lines[0].unit = 'L';
  delete other.checks.vehicle_frozen_c;
  await assert.rejects(() => receive(withReading, other), /would mean nothing/);
});

test('the van reading is required when the load needs it, and refused when it does not', async () => {
  const missing = intakeDb();
  const payload = delivery();
  delete payload.checks.vehicle_frozen_c;
  await assert.rejects(() => receive(missing, payload), /vehicle_frozen_c is required/);

  const spurious = intakeDb();
  const ambient = delivery();
  ambient.lines[0].item_id = 'item:oil';
  ambient.lines[0].unit = 'L';
  delete ambient.lines[0].product_temp_c;
  await assert.rejects(() => receive(spurious, ambient), /contains no frozen stock/);
});

test('a reading within limit is kept as the evidence the check happened', async () => {
  const db = intakeDb();
  await receive(db, delivery());
  const readings = sqlOf(db, 'INSERT INTO temperature_readings');
  assert.equal(readings.length, 2, 'the van and the one line');
  assert.deepEqual(readings.map((row) => row.params[6]), [1, 1], 'both within limit');
  assert.equal(lotFields(db).status, 'open');
});

test('a warm probe holds the lot and opens a deviation', async () => {
  const db = intakeDb();
  const payload = delivery();
  payload.lines[0].product_temp_c = -4;
  await receive(db, payload);

  assert.equal(lotFields(db).status, 'held');
  const deviations = sqlOf(db, 'INSERT INTO temperature_deviations');
  assert.equal(deviations.length, 1);
  assert.equal(deviations[0].params[4], '2026-08-31T09:44:00.000Z', 'recheck due half an hour later');
});

test('a warm van holds every lot it applies to, however well each one probed', async () => {
  // One good probe reading does not clear a load that travelled warm.
  const db = intakeDb();
  const payload = delivery();
  payload.checks.vehicle_frozen_c = -9;
  payload.lines.push({
    ...payload.lines[0],
    lot_id: '01J8XQZ5T7M4QPB9CDEFGHJKMQ',
    short_code: 'K9NR2T',
  });
  db.state.shortCodes.K9NR2T = { code: 'K9NR2T', device_id: 'dev:ipad', lot_id: null };

  await receive(db, payload);

  assert.equal(lotFields(db, 0).status, 'held');
  assert.equal(lotFields(db, 1).status, 'held');
  assert.equal(sqlOf(db, 'INSERT INTO temperature_deviations').length, 2, 'one per lot');
});

test('lots are written before the readings that point at them', async () => {
  // Foreign keys are checked as each statement runs, not at the end of the
  // batch, so a reading written first would fail on a lot that does not exist.
  const db = intakeDb();
  await receive(db, delivery());
  const order = db.written.map((statement) => statement.sql);
  const lotAt = order.findIndex((sql) => sql.includes('INSERT INTO lots'));
  const readingAt = order.findIndex((sql) => sql.includes('INSERT INTO temperature_readings'));
  assert.ok(lotAt < readingAt, 'lots come first');
});
