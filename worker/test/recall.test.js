import test from 'node:test';
import assert from 'node:assert/strict';
import { recall, MAX_DEPTH } from '../src/ledger/recall.js';
import { sqliteDb } from './sqliteDb.js';

// A small kitchen, built with plain INSERTs against the real schema:
//
//   carcass C1 ──► garlic oil G1 ──► broth B1 ──► dispatched to Maki 6, 10 L
//        │                            ▲    └────► 5 L still in the freezer
//        └────────────────────────────┘
//        └──► broth B2 ──► 2 L wasted
//
// B1 is reached twice (from C1 directly and through G1), which is the diamond
// a correct walk has to show once. B3 used carcass with no lot named while C1
// was in date; B4 did so before C1 existed, so it cannot have contained it.
// Which submission kind writes each movement type.
const KIND = {
  RECEIVE: 'receive', CONSUME: 'produce', PRODUCE: 'produce', DISPATCH: 'dispatch', WASTE: 'waste',
};

function kitchen() {
  const db = sqliteDb();
  const { sqlite } = db;
  sqlite.exec(`
    INSERT INTO staff (id, name) VALUES ('s1', 'Dean');
    INSERT INTO suppliers (id, name) VALUES ('lynas', 'Lynas');
    INSERT INTO customers (id, name) VALUES ('maki6', 'Maki 6 - Bath Street');
    INSERT INTO locations (id, name, kind) VALUES ('fr', 'Walk In Freezer', 'freezer');
    INSERT INTO items (id, name, kind, base_unit) VALUES
      ('carcass', 'Chicken Carcass', 'ingredient', 'kg'),
      ('oil', 'Garlic Oil', 'product', 'L'),
      ('broth', 'Chicken Broth', 'product', 'L');
  `);

  let n = 0;
  const event = (kind, at) => {
    n += 1;
    sqlite.prepare(
      `INSERT INTO events (id, kind, idempotency_key, payload_hash, staff_id, occurred_at, payload)
       VALUES (?, ?, ?, 'h', 's1', ?, '{}')`,
    ).run(`e${n}`, kind, `k${n}`, at);
    return `e${n}`;
  };
  const lot = (id, item, origin, at, extra = {}) => {
    sqlite.prepare(
      `INSERT INTO lots (id, item_id, short_code, origin, supplier_id, originated_at, use_by, use_by_source, event_id)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(id, item, origin, origin === 'received' ? 'lynas' : null, at,
      extra.use_by ?? null, extra.use_by ? 'supplier_printed' : null, event('receive', at));
  };
  const move = (lotId, type, quantity, at, extra = {}) => {
    sqlite.prepare(
      `INSERT INTO movements (id, lot_id, type, quantity, from_location_id, to_location_id,
                              counterpart_lot_id, occurred_at, staff_id, reason, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 's1', ?, ?)`,
    ).run(`m${(n += 1)}`, lotId, type, quantity,
      quantity < 0 ? 'fr' : null, quantity > 0 ? 'fr' : null,
      extra.counterpart ?? null, at, extra.reason ?? null, extra.event ?? event(KIND[type], at));
  };

  lot('C1', 'carcass', 'received', '2026-09-01T09:00:00Z', { use_by: '2026-09-08' });
  move('C1', 'RECEIVE', 80, '2026-09-01T09:00:00Z');
  lot('G1', 'oil', 'produced', '2026-09-02T10:00:00Z');
  lot('B1', 'broth', 'produced', '2026-09-03T10:00:00Z', { use_by: '2027-09-03' });
  lot('B2', 'broth', 'produced', '2026-09-04T10:00:00Z');
  lot('B3', 'broth', 'produced', '2026-09-05T10:00:00Z');
  lot('B4', 'broth', 'produced', '2026-08-20T10:00:00Z');

  move('C1', 'CONSUME', -8, '2026-09-02T10:00:00Z', { counterpart: 'G1' });
  move('C1', 'CONSUME', -8, '2026-09-03T10:00:00Z', { counterpart: 'B1' });
  move('G1', 'CONSUME', -1, '2026-09-03T10:00:00Z', { counterpart: 'B1' });
  move('C1', 'CONSUME', -8, '2026-09-04T10:00:00Z', { counterpart: 'B2' });

  move('B1', 'PRODUCE', 15, '2026-09-03T11:00:00Z');
  move('B2', 'PRODUCE', 12, '2026-09-04T11:00:00Z');
  const note = event('dispatch', '2026-09-05T08:00:00Z');
  sqlite.prepare(`INSERT INTO dispatches (event_id, customer_id, reference, vehicle_condition)
                  VALUES (?, 'maki6', 'DN-114', 'good')`).run(note);
  move('B1', 'DISPATCH', -10, '2026-09-05T08:00:00Z', { event: note });
  move('B2', 'WASTE', -2, '2026-09-06T08:00:00Z', { reason: 'spillage' });

  const unproven = (id, batch, item, at) => {
    sqlite.prepare(
      `INSERT INTO unproven_inputs (id, event_id, lot_id, item_id, quantity, unit, reason, staff_id)
       VALUES (?, ?, ?, ?, 8, 'kg', 'label gone', 's1')`,
    ).run(id, event('produce', at), batch, item);
  };
  unproven('u3', 'B3', 'carcass', '2026-09-05T10:00:00Z');
  unproven('u4', 'B4', 'carcass', '2026-08-20T10:00:00Z');

  return db;
}

const ids = (rows) => rows.map((row) => row.id ?? row.lot_id).sort();

test('forward from an ingredient lot reaches the product lots and the customer', async () => {
  const result = await recall(kitchen(), 'C1');
  assert.equal(result.start.id, 'C1');
  assert.deepEqual(ids(result.lots), ['B1', 'B2', 'G1']);
  assert.equal(result.customers.length, 1);
  assert.equal(result.customers[0].customer_name, 'Maki 6 - Bath Street');
  assert.equal(result.customers[0].reference, 'DN-114');
  assert.equal(result.customers[0].lot_id, 'B1');
  assert.equal(result.customers[0].quantity, 10);
  assert.equal(result.truncated, false);
});

test('a lot reached two ways is listed once, naming both routes', async () => {
  const result = await recall(kitchen(), 'C1');
  const b1 = result.lots.filter((lot) => lot.id === 'B1');
  assert.equal(b1.length, 1);
  assert.deepEqual([...b1[0].from].sort(), ['C1', 'G1']);
  assert.equal(b1[0].depth, 1, 'depth is the shortest route');
});

test('stock still on hand and stock binned are separate lists', async () => {
  const result = await recall(kitchen(), 'C1');
  const remaining = Object.fromEntries(result.on_hand.map((row) => [row.lot_id, row.quantity]));
  assert.equal(remaining.B1, 5, '15 made less 10 dispatched');
  assert.equal(remaining.B2, 10, '12 made less 2 wasted');
  assert.equal(remaining.C1, 56, 'the origin lot is included: 80 less 24 consumed');
  assert.equal(result.wasted.length, 1);
  assert.equal(result.wasted[0].lot_id, 'B2');
  assert.equal(result.wasted[0].reason, 'spillage');
});

test('a batch that used the item with no lot named is a gap, only inside the window', async () => {
  const result = await recall(kitchen(), 'C1');
  assert.deepEqual(result.gaps.map((gap) => gap.batch_lot_id), ['B3']);
  assert.equal(result.gaps[0].kind, 'possible_downstream');
  assert.deepEqual(result.gaps[0].could_be, ['C1']);
  assert.equal(result.gaps[0].reason, 'label gone');
});

test('back from a product lot reaches the ingredient and its supplier', async () => {
  const result = await recall(kitchen(), 'B1', 'back');
  assert.deepEqual(ids(result.lots), ['C1', 'G1']);
  const carcass = result.lots.find((lot) => lot.id === 'C1');
  assert.equal(carcass.supplier_name, 'Lynas');
  assert.equal(result.customers.length, 1, 'who received the lot asked about');
  assert.deepEqual(result.gaps, []);
});

test('back names a batch in the ancestry that used something with no lot', async () => {
  const result = await recall(kitchen(), 'B3', 'back');
  assert.deepEqual(result.lots, []);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].kind, 'missing_upstream');
  assert.equal(result.gaps[0].item_name, 'Chicken Carcass');
});

test('a cycle terminates and each lot appears once', async () => {
  const db = kitchen();
  db.sqlite.prepare(
    `INSERT INTO movements (id, lot_id, type, quantity, from_location_id, counterpart_lot_id,
                            occurred_at, staff_id, event_id)
     VALUES ('loop', 'B1', 'CONSUME', -1, 'fr', 'C1', '2026-09-07T00:00:00Z', 's1', 'e1')`,
  ).run();
  const result = await recall(db, 'C1');
  assert.deepEqual(ids(result.lots), ['B1', 'B2', 'G1']);
  assert.equal(result.truncated, false);
});

test('a chain deeper than the cap says it was cut short', async () => {
  const db = kitchen();
  let previous = 'C1';
  for (let i = 0; i < MAX_DEPTH + 2; i += 1) {
    const id = `X${i}`;
    db.sqlite.prepare(
      `INSERT INTO lots (id, item_id, origin, originated_at, event_id)
       VALUES (?, 'broth', 'produced', '2026-09-10T00:00:00Z', 'e1')`,
    ).run(id);
    db.sqlite.prepare(
      `INSERT INTO movements (id, lot_id, type, quantity, from_location_id, counterpart_lot_id,
                              occurred_at, staff_id, event_id)
       VALUES (?, ?, 'CONSUME', -1, 'fr', ?, '2026-09-10T00:00:00Z', 's1', 'e1')`,
    ).run(`chain${i}`, previous, id);
    previous = id;
  }
  const result = await recall(db, 'C1');
  assert.equal(result.truncated, true);
  assert.ok(result.lots.every((lot) => lot.depth <= MAX_DEPTH));
});

test('an unknown lot, a missing lot and a bad direction are refused', async () => {
  const db = kitchen();
  await assert.rejects(() => recall(db, 'ghost'), /no lot "ghost"/);
  await assert.rejects(() => recall(db, ''), /lot is required/);
  await assert.rejects(() => recall(db, 'C1', 'sideways'), /direction must be one of/);
});

test('a lot with no descendants returns empty lists, not an error', async () => {
  const result = await recall(kitchen(), 'B2');
  assert.deepEqual(result.lots, []);
  assert.deepEqual(result.customers, []);
});
