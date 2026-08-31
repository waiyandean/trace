import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ulid, makeStore, makeQueue, makePool, unitsFor, defaultBatchCode, buildSubmission, syncQueue,
} from '../public/lib/offline.js';

// A localStorage stand-in, with a switch for the case that matters: storage
// that throws rather than storing, which is what a locked-down iPad does.
function fakeStorage({ broken = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem(key) {
      if (broken) throw new Error('storage denied');
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (broken) throw new Error('storage denied');
      map.set(key, value);
    },
  };
}

const storeOn = (storage) => makeStore(storage);

test('a minted id is a ULID the server will accept', () => {
  assert.match(ulid(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('ids minted in the same millisecond differ', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) ids.add(ulid(1756630000000));
  assert.equal(ids.size, 50);
});

test('ids sort in the order they were minted', () => {
  const first = ulid(1756630000000);
  const second = ulid(1756630001000);
  assert.ok(first < second);
});

test('storage that throws is survivable rather than fatal', () => {
  const store = storeOn(fakeStorage({ broken: true }));
  assert.deepEqual(store.read('anything', 'fallback'), 'fallback');
  assert.equal(store.write('anything', 1), false, 'the caller is told it did not stick');
});

test('a submission is queued before it is sent', () => {
  const queue = makeQueue(storeOn(fakeStorage()));
  queue.add({ idempotency_key: 'k1' });
  assert.equal(queue.pending().length, 1);
  assert.equal(queue.all()[0].status, 'pending');
});

test('a rejected submission stays in the queue where a person will see it', async () => {
  const queue = makeQueue(storeOn(fakeStorage()));
  queue.add({ idempotency_key: 'k1' });
  await syncQueue(queue, async () => ({ ok: false, status: 400, body: { error: 'unknown item "nope"' } }));

  assert.equal(queue.pending().length, 0);
  assert.equal(queue.rejected().length, 1);
  assert.equal(queue.rejected()[0].error, 'unknown item "nope"');
});

test('a submission the server accepted keeps what it wrote', async () => {
  const queue = makeQueue(storeOn(fakeStorage()));
  queue.add({ idempotency_key: 'k1' });
  const results = await syncQueue(queue, async () => ({ ok: true, status: 201, body: { lots: [{ id: 'lot1' }] } }));

  assert.equal(results.sent, 1);
  assert.equal(queue.all()[0].status, 'sent');
  assert.equal(queue.all()[0].result.lots[0].id, 'lot1');
});

test('no network leaves the submission pending and stops trying', async () => {
  const queue = makeQueue(storeOn(fakeStorage()));
  queue.add({ idempotency_key: 'k1' });
  queue.add({ idempotency_key: 'k2' });

  let attempts = 0;
  const results = await syncQueue(queue, async () => {
    attempts += 1;
    throw new Error('offline');
  });

  assert.equal(attempts, 1, 'it stops at the first failure rather than hammering');
  assert.equal(results.waiting, 1);
  assert.equal(queue.pending().length, 2, 'nothing was lost');
});

test('submissions sync in the order they were keyed', async () => {
  const queue = makeQueue(storeOn(fakeStorage()));
  queue.add({ idempotency_key: 'first' });
  queue.add({ idempotency_key: 'second' });

  const seen = [];
  await syncQueue(queue, async (payload) => {
    seen.push(payload.idempotency_key);
    return { ok: true, status: 201, body: {} };
  });
  assert.deepEqual(seen, ['first', 'second']);
});

test('only confirmed submissions can be cleared', () => {
  const queue = makeQueue(storeOn(fakeStorage()));
  queue.add({ idempotency_key: 'k1' });
  queue.add({ idempotency_key: 'k2' });
  queue.update('k1', { status: 'sent' });
  queue.update('k2', { status: 'rejected' });

  queue.clearSent();
  assert.equal(queue.all().length, 1);
  assert.equal(queue.all()[0].status, 'rejected');
});

test('a code is spent the moment it is taken', () => {
  const pool = makePool(storeOn(fakeStorage()));
  pool.replace('dev:ipad', ['AAAAAA', 'BBBBBB']);
  assert.equal(pool.take(), 'AAAAAA');
  assert.equal(pool.remaining(), 1);
  assert.equal(pool.take(), 'BBBBBB');
  assert.equal(pool.take(), null, 'an empty pool is a normal outcome, not a throw');
});

test('a code handed back goes to the end rather than straight out again', () => {
  const pool = makePool(storeOn(fakeStorage()));
  pool.replace('dev:ipad', ['AAAAAA', 'BBBBBB']);
  const taken = pool.take();
  pool.giveBack(taken);
  assert.deepEqual(pool.state().codes, ['BBBBBB', 'AAAAAA']);
});

test('the server is the authority on what the pool holds', () => {
  const pool = makePool(storeOn(fakeStorage()));
  pool.replace('dev:ipad', ['AAAAAA', 'BBBBBB']);
  pool.replace('dev:ipad', ['CCCCCC']);
  assert.deepEqual(pool.state().codes, ['CCCCCC']);
});

test('a low pool is noticed before it is empty', () => {
  const pool = makePool(storeOn(fakeStorage()));
  pool.replace('dev:ipad', Array.from({ length: 39 }, (_, i) => `C${i}`));
  assert.equal(pool.isLow(), true);
  pool.replace('dev:ipad', Array.from({ length: 60 }, (_, i) => `C${i}`));
  assert.equal(pool.isLow(), false);
});

test('only units the catalog can convert are offered', () => {
  const item = { id: 'i1', base_unit: 'kg' };
  const conversions = [
    { item_id: 'i1', from_unit: 'case', to_unit: 'item' },
    { item_id: 'i1', from_unit: 'item', to_unit: 'kg' },
    { item_id: 'other', from_unit: 'drum', to_unit: 'L' },
  ];
  assert.deepEqual(unitsFor(item, conversions).sort(), ['case', 'item', 'kg']);
});

test('an item with no conversions can still be keyed in its base unit', () => {
  assert.deepEqual(unitsFor({ id: 'i1', base_unit: 'Units' }, []), ['Units']);
});

test('the batch code is the date, as the kitchen already writes it', () => {
  assert.equal(defaultBatchCode(new Date('2026-08-31T14:00:00Z')), '2026-08-31');
});

test('a draft becomes the submission the server takes', () => {
  const submission = buildSubmission(
    {
      device_id: 'dev:ipad',
      staff_id: 'staff:nikin',
      supplier_id: 'sup:lynas',
      invoice: '009298395',
      occurred_at: '2026-08-31T09:14:00.000Z',
      lines: [
        { lot_id: 'L1', item_id: 'i1', short_code: 'K7M4QP', quantity: 3, unit: 'case', location_id: 'loc:fridge', use_by: '2026-09-04', batch_code: '2026-08-31' },
      ],
    },
    { mintId: () => '01J8XQZ5T7M4QPB9CDEFGHJKMN' },
  );

  assert.match(submission.event_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(submission.idempotency_key, /^goods-in-/);
  assert.equal(submission.occurred_at, '2026-08-31T09:14:00.000Z');
  assert.equal(submission.lines[0].quantity, 3);
});

test('a line with no use-by omits it, so the shelf-life rule applies on the server', () => {
  const submission = buildSubmission({
    device_id: 'd', staff_id: 's', supplier_id: 'sup',
    lines: [{ lot_id: 'L1', item_id: 'i1', quantity: 1, unit: 'kg', location_id: 'loc', use_by: '' }],
  });
  const line = JSON.parse(JSON.stringify(submission.lines[0]));
  assert.equal('use_by' in line, false);
  assert.equal('short_code' in line, false);
});

test('a queued submission keeps its key across a retry', async () => {
  const queue = makeQueue(storeOn(fakeStorage()));
  const submission = buildSubmission({
    device_id: 'd', staff_id: 's', supplier_id: 'sup',
    lines: [{ lot_id: 'L1', item_id: 'i1', quantity: 1, unit: 'kg', location_id: 'loc' }],
  });
  queue.add(submission);

  await syncQueue(queue, async () => { throw new Error('offline'); });
  const keys = [];
  await syncQueue(queue, async (payload) => {
    keys.push(payload.idempotency_key);
    return { ok: true, status: 200, body: { duplicate: true } };
  });
  assert.deepEqual(keys, [submission.idempotency_key]);
});
