import test from 'node:test';
import assert from 'node:assert/strict';
import { periodBalance } from '../src/ledger/balance.js';
import { sqliteDb } from './sqliteDb.js';

// Chicken Carcass is bulk: a case converts straight to kg, so its kilograms
// are nominal. Sesame Oil is counted through a bottle, so they are not.
//
// Carcass: 80 kg in on 1 Sep; 8 kg into a batch on the 2nd, 3rd and 4th; a
// count on the 7th writes 4 kg off; a batch on the 5th used 8 kg with no lot
// named. Broth: 15 L made on the 3rd, 10 L dispatched on the 5th, 2 L binned
// on the 6th, and a pair of MOVE rows on the 4th that must change nothing.
function kitchen() {
  const db = sqliteDb();
  db.sqlite.exec(`
    INSERT INTO staff (id, name) VALUES ('s1', 'Dean');
    INSERT INTO suppliers (id, name) VALUES ('lynas', 'Lynas');
    INSERT INTO customers (id, name) VALUES ('maki6', 'Maki 6');
    INSERT INTO locations (id, name, kind) VALUES ('fr', 'Freezer', 'freezer'), ('ch', 'Fridge', 'chill');
    INSERT INTO items (id, name, kind, base_unit) VALUES
      ('carcass', 'Chicken Carcass', 'ingredient', 'kg'),
      ('sesame', 'Sesame Oil', 'ingredient', 'L'),
      ('broth', 'Chicken Broth', 'product', 'L');
    INSERT INTO unit_conversions (item_id, from_unit, to_unit, factor) VALUES
      ('carcass', 'case', 'kg', 8), ('sesame', 'case', 'item', 6), ('sesame', 'item', 'L', 2);
    INSERT INTO events (id, kind, idempotency_key, payload_hash, staff_id, occurred_at, payload) VALUES
      ('e1', 'receive', 'k1', 'h', 's1', '2026-09-01T09:00:00Z', '{}'),
      ('e2', 'produce', 'k2', 'h', 's1', '2026-09-03T10:00:00Z', '{}'),
      ('e3', 'dispatch', 'k3', 'h', 's1', '2026-09-05T08:00:00Z', '{}'),
      ('e4', 'waste', 'k4', 'h', 's1', '2026-09-06T08:00:00Z', '{}'),
      ('e5', 'count', 'k5', 'h', 's1', '2026-09-07T08:00:00Z', '{}'),
      ('e6', 'move', 'k6', 'h', 's1', '2026-09-04T08:00:00Z', '{}');
    INSERT INTO lots (id, item_id, origin, supplier_id, originated_at, event_id) VALUES
      ('C1', 'carcass', 'received', 'lynas', '2026-09-01T09:00:00Z', 'e1'),
      ('S1', 'sesame', 'received', 'lynas', '2026-09-01T09:00:00Z', 'e1'),
      ('B1', 'broth', 'produced', NULL, '2026-09-03T10:00:00Z', 'e2'),
      ('B2', 'broth', 'produced', NULL, '2026-09-05T10:00:00Z', 'e2');
    INSERT INTO movements (id, lot_id, type, quantity, from_location_id, to_location_id, counterpart_lot_id, occurred_at, staff_id, reason, event_id) VALUES
      ('m1', 'C1', 'RECEIVE', 80, NULL, 'fr', NULL, '2026-09-01T09:00:00Z', 's1', NULL, 'e1'),
      ('m2', 'C1', 'CONSUME', -8, 'fr', NULL, 'B1', '2026-09-02T10:00:00Z', 's1', NULL, 'e2'),
      ('m3', 'C1', 'CONSUME', -8, 'fr', NULL, 'B1', '2026-09-03T10:00:00Z', 's1', NULL, 'e2'),
      ('m4', 'C1', 'CONSUME', -8, 'fr', NULL, 'B1', '2026-09-04T10:00:00Z', 's1', NULL, 'e2'),
      ('m5', 'C1', 'ADJUST', -4, 'fr', NULL, NULL, '2026-09-07T08:00:00Z', 's1', 'count', 'e5'),
      ('m6', 'S1', 'RECEIVE', 12, NULL, 'ch', NULL, '2026-09-01T09:00:00Z', 's1', NULL, 'e1'),
      ('m7', 'S1', 'ADJUST', 1, NULL, 'ch', NULL, '2026-09-07T08:00:00Z', 's1', 'count', 'e5'),
      ('m8', 'B1', 'PRODUCE', 15, NULL, 'fr', NULL, '2026-09-03T11:00:00Z', 's1', NULL, 'e2'),
      ('m9', 'B1', 'DISPATCH', -10, 'fr', NULL, NULL, '2026-09-05T08:00:00Z', 's1', NULL, 'e3'),
      ('m10', 'B1', 'WASTE', -2, 'fr', NULL, NULL, '2026-09-06T08:00:00Z', 's1', 'spillage', 'e4'),
      ('m11', 'B1', 'MOVE', -3, 'fr', NULL, NULL, '2026-09-04T08:00:00Z', 's1', NULL, 'e6'),
      ('m12', 'B1', 'MOVE', 3, NULL, 'ch', NULL, '2026-09-04T08:00:00Z', 's1', NULL, 'e6');
    INSERT INTO unproven_inputs (id, event_id, lot_id, item_id, quantity, unit, reason, staff_id) VALUES
      ('u1', 'e2', 'B2', 'carcass', 8, 'kg', 'label gone', 's1'),
      ('u2', 'e2', 'B2', 'carcass', 1, 'case', 'label gone', 's1');
  `);
  return db;
}

const by = (result, id) => result.rows.find((row) => row.item_id === id);

test('a period reports opening, each flow, and closing', async () => {
  const carcass = by(await periodBalance(kitchen(), { from: '2026-09-03', to: '2026-09-08' }), 'carcass');
  assert.equal(carcass.opening, 72, '80 in on the 1st less 8 used on the 2nd');
  assert.equal(carcass.received, 0);
  assert.equal(carcass.consumed, 16);
  assert.equal(carcass.adjusted, -4);
  assert.equal(carcass.adjusted_down, 4);
  assert.equal(carcass.adjusted_up, 0);
  assert.equal(carcass.closing, 52);
  assert.equal(carcass.other, 0);
});

test('the whole run of days reconciles with nothing left over', async () => {
  const result = await periodBalance(kitchen(), { from: '2026-09-01', to: '2026-09-30' });
  for (const row of result.rows) assert.equal(row.other, 0, `${row.name} should reconcile`);
  const broth = by(result, 'broth');
  assert.equal(broth.produced, 15);
  assert.equal(broth.dispatched, 10);
  assert.equal(broth.wasted, 2);
  assert.equal(broth.closing, 3, '15 made less 10 sent and 2 binned; the MOVE rows net to nothing');
});

test('the end date is inclusive and the day after is not', async () => {
  const kept = by(await periodBalance(kitchen(), { from: '2026-09-07', to: '2026-09-07' }), 'carcass');
  assert.equal(kept.adjusted, -4, 'a movement on the last day is counted');
  const cut = await periodBalance(kitchen(), { from: '2026-09-01', to: '2026-09-06' });
  assert.equal(by(cut, 'carcass').adjusted, 0, 'the count on the 7th is outside');
  assert.equal(by(cut, 'carcass').closing, 56);
});

test('what the counts corrected is a share of what there was to lose', async () => {
  const carcass = by(await periodBalance(kitchen(), { from: '2026-09-01', to: '2026-09-30' }), 'carcass');
  assert.equal(carcass.adjusted_pct, -5, '-4 of 80');
  const quiet = by(await periodBalance(kitchen(), { from: '2026-09-04', to: '2026-09-06' }), 'broth');
  assert.equal(quiet.adjusted_pct, 0);
});

test('an item with no history yet is absent, and one carried in from before still shows', async () => {
  const early = await periodBalance(kitchen(), { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(by(early, 'carcass'), undefined, 'nothing had happened by the end of August');
  const late = by(await periodBalance(kitchen(), { from: '2026-09-08', to: '2026-09-30' }), 'carcass');
  assert.equal(late.opening, 52, 'no activity in the period, but the balance is still on the shelf');
  assert.equal(late.closing, 52);
});

test('bulk kilograms are marked nominal, and only those', async () => {
  const result = await periodBalance(kitchen(), { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(by(result, 'carcass').nominal, true);
  assert.equal(by(result, 'sesame').nominal, false);
  assert.equal(by(result, 'broth').nominal, false);
});

test('use with no lot named is stated beside the row, in the unit given', async () => {
  const carcass = by(await periodBalance(kitchen(), { from: '2026-09-01', to: '2026-09-30' }), 'carcass');
  assert.equal(carcass.unproven, 8, 'the kg entry is added in');
  assert.deepEqual(carcass.unproven_other_units, [{ unit: 'case', quantity: 1 }],
    'the case entry cannot be added to kg, so it is stated as given');
  const outside = by(await periodBalance(kitchen(), { from: '2026-09-01', to: '2026-09-04' }), 'carcass');
  assert.equal(outside.unproven, 0, 'the batch was on the 5th');
});

test('rows are ordered by the size of the correction, biggest first', async () => {
  const result = await periodBalance(kitchen(), { from: '2026-09-01', to: '2026-09-30' });
  const pct = result.rows.map((row) => Math.abs(row.adjusted_pct ?? 0));
  assert.deepEqual(pct, [...pct].sort((a, b) => b - a));
  assert.deepEqual(result.rows.slice(0, 2).map((row) => row.item_id), ['sesame', 'carcass'],
    '+1 of 12 L is 8.3%, more than -4 of 80 kg at 5%');
});

test('one item, or one kind, can be asked for', async () => {
  const one = await periodBalance(kitchen(), { from: '2026-09-01', to: '2026-09-30', item: 'sesame' });
  assert.deepEqual(one.rows.map((row) => row.item_id), ['sesame']);
  const products = await periodBalance(kitchen(), { from: '2026-09-01', to: '2026-09-30', kind: 'product' });
  assert.deepEqual(products.rows.map((row) => row.item_id), ['broth']);
});

test('bad input is refused, naming what was wrong', async () => {
  const db = kitchen();
  await assert.rejects(() => periodBalance(db, { to: '2026-09-30' }), /from must be a date/);
  await assert.rejects(() => periodBalance(db, { from: '2026-09-01', to: '30/09/2026' }), /to must be a date/);
  await assert.rejects(() => periodBalance(db, { from: '2026-02-30', to: '2026-03-01' }), /from must be a date/);
  await assert.rejects(() => periodBalance(db, { from: '2026-09-30', to: '2026-09-01' }), /must not be after/);
  await assert.rejects(() => periodBalance(db, { from: '2026-09-01', to: '2026-09-30', kind: 'sauce' }),
    /kind must be one of/);
});
