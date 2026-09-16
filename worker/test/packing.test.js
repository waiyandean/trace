import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBatchCode, POT_ITEMS, recordPacking } from '../src/ledger/packing.js';

// The scheme itself (HANDOFF.md, "Batch codes"): ddmm, the GA suffix, then a
// pot 1-8 for products cooked several times a day. The code is computed on
// the device (lib/offline.js's batchCodeFor pattern) using local wall-clock
// date components; this only validates the shape it should have arrived in.

test('the two broths need a pot number', () => {
  assert.ok(POT_ITEMS.has('Chicken Broth'));
  assert.ok(POT_ITEMS.has('Tonkotsu Broth'));
  assert.equal(POT_ITEMS.size, 2);
});

test('a plain product accepts ddmm + GA', () => {
  assert.doesNotThrow(() => checkBatchCode('1609GA', 'Chilli Oil'));
});

test('a plain product refuses a pot number tacked on', () => {
  assert.throws(() => checkBatchCode('1609GA3', 'Chilli Oil'), /must be ddmm followed by GA/);
});

test('a broth requires a pot number 1-8', () => {
  assert.doesNotThrow(() => checkBatchCode('1609GA1', 'Tonkotsu Broth'));
  assert.doesNotThrow(() => checkBatchCode('1609GA8', 'Chicken Broth'));
});

test('a broth without a pot number is refused, not silently accepted', () => {
  assert.throws(() => checkBatchCode('1609GA', 'Tonkotsu Broth'), /cooked several pots a day/);
});

test('a pot number outside 1-8 is refused', () => {
  assert.throws(() => checkBatchCode('1609GA0', 'Tonkotsu Broth'), /cooked several pots a day/);
  assert.throws(() => checkBatchCode('1609GA9', 'Tonkotsu Broth'), /cooked several pots a day/);
});

test('missing or empty is refused by name, not just by shape', () => {
  assert.throws(() => checkBatchCode(null, 'Chilli Oil'), /batch_code is required/);
  assert.throws(() => checkBatchCode('', 'Chilli Oil'), /batch_code is required/);
  assert.throws(() => checkBatchCode(undefined, 'Chilli Oil'), /batch_code is required/);
});

test('a code with a wrong day/month width or a different suffix is refused', () => {
  assert.throws(() => checkBatchCode('160GA', 'Chilli Oil'), /must be ddmm followed by GA/);
  assert.throws(() => checkBatchCode('1609XY', 'Chilli Oil'), /must be ddmm followed by GA/);
});

// ---------------------------------------------------------- recordPacking

// A device-less D1 stand-in for recordPacking: no device pool the way
// goods-in's tests need one, since batching has no device at all.
function packingDb({ shortCode = null, existingCodes = new Set() } = {}) {
  const state = {
    staff: { 'staff:nikin': { id: 'staff:nikin', name: 'Nikin', active: 1 } },
    events: {},
    locations: { 'loc:fridge': { id: 'loc:fridge', name: 'Walk In Fridge', active: 1 } },
    record: {
      lot_id: 'lot:broth', packed_at: null, event_id: 'ev:produce',
      item_id: 'item:broth', item_name: 'Tonkotsu Broth', base_unit: 'L', short_code: shortCode,
    },
  };
  const written = [];
  return {
    state,
    written,
    existingCodes,
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
          if (sql.includes('FROM staff')) return state.staff[id] ?? null;
          if (sql.includes('FROM events')) return state.events[id] ?? null;
          if (sql.includes('b.packed_at')) return state.record;
          if (sql.includes('b.yield_quantity')) {
            return { lot_id: state.record.lot_id, yield_quantity: 40, multiplier: 1, packets_produced: 20, label_check: 1, product_name: state.record.item_name, base_unit: state.record.base_unit };
          }
          if (sql.includes('FROM locations')) return state.locations[id] ?? null;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT INTO short_codes')) {
            const [code] = statement.params;
            if (existingCodes.has(code)) return { success: true, meta: { changes: 0 } };
            existingCodes.add(code);
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
}

const note = (changes = {}) => ({
  event_id: '01HZZZZZZZZZZZZZZZZZZZZZZZ', idempotency_key: 'pack-00000000000000000001', staff_id: 'staff:nikin',
  occurred_at: '2026-09-16T12:00:00Z', lot_id: 'lot:broth', location_id: 'loc:fridge',
  yield_quantity: 40, yield_unit: 'L', packets_produced: 20, label_check: true, batch_code: '1609GA1',
  ...changes,
});

test('mints and binds a fresh short code when the lot has none', async () => {
  const db = packingDb();
  const result = await recordPacking(db, note());
  assert.equal(result.duplicate, false);
  assert.match(result.short_code, /^[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(result.batch_code, '1609GA1');

  // The mint-and-bind insert happens outside the atomic batch (it is a
  // conditional retry loop, which db.batch() cannot express), so the proof
  // is in the fake's own bookkeeping rather than db.written: the code
  // recordPacking returned is the one actually inserted.
  assert.ok(db.existingCodes.has(result.short_code));
});

test('keeps an existing short code rather than minting a second', async () => {
  const db = packingDb({ shortCode: 'ABCDEF' });
  const result = await recordPacking(db, note());
  assert.equal(result.short_code, 'ABCDEF');
  const minted = db.written.some((s) => s.sql.includes('INSERT INTO short_codes'));
  assert.equal(minted, false);
});

test('a produced lot missing a batch_code is refused before anything is written', async () => {
  const db = packingDb();
  await assert.rejects(() => recordPacking(db, note({ batch_code: undefined })), /batch_code is required/);
  assert.equal(db.written.length, 0);
});

test('a broth packed without a pot number is refused', async () => {
  const db = packingDb();
  await assert.rejects(() => recordPacking(db, note({ batch_code: '1609GA' })), /cooked several pots a day/);
});
