import test from 'node:test';
import assert from 'node:assert/strict';
import { openUnproven, reviewUnproven } from '../src/ledger/unproven.js';
import { fakeDb } from './fakeDb.js';

function rowsFor(call) {
  if (call.sql.includes('FROM unproven_inputs u') && call.sql.includes('JOIN items i')) {
    return [
      {
        id: 'unproven:1',
        item_id: 'item:carcass',
        quantity: 8,
        unit: 'kg',
        reason: 'case had no label',
        created_at: '2026-09-02T10:00:00Z',
        batch_lot_id: 'lot:broth1',
        item_name: 'Chicken Carcass',
        product_name: 'Chicken Broth',
        batch_short_code: 'K7M4QP',
        staff_name: 'Nikin',
      },
    ];
  }
  if (call.sql.startsWith('SELECT id, reviewed_at FROM unproven_inputs')) {
    return [{ id: call.params[0], reviewed_at: null }];
  }
  if (call.sql.startsWith('SELECT id, name, active FROM staff')) {
    return [{ id: call.params[0], name: 'Dean', active: 1 }];
  }
  return [];
}

test('open unproven inputs list the batch and reason, unreviewed only', async () => {
  const db = fakeDb(rowsFor);
  const rows = await openUnproven(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_name, 'Chicken Carcass');
  assert.equal(rows[0].product_name, 'Chicken Broth');
  assert.match(db.calls[0].sql, /reviewed_at IS NULL/);
});

test('reviewing needs a known, active staff member', async () => {
  const db = fakeDb((call) => {
    if (call.sql.startsWith('SELECT id, reviewed_at')) return [{ id: 'unproven:1', reviewed_at: null }];
    if (call.sql.startsWith('SELECT id, name, active FROM staff')) return [];
    return [];
  });
  await assert.rejects(
    () => reviewUnproven(db, { unproven_id: 'unproven:1', staff_id: 'staff:ghost' }),
    /unknown staff/,
  );
});

test('an already-reviewed row cannot be reviewed twice', async () => {
  const db = fakeDb((call) => {
    if (call.sql.startsWith('SELECT id, reviewed_at')) {
      return [{ id: 'unproven:1', reviewed_at: '2026-09-02T11:00:00Z' }];
    }
    return [];
  });
  await assert.rejects(
    () => reviewUnproven(db, { unproven_id: 'unproven:1', staff_id: 'staff:dean' }),
    /already reviewed/,
  );
});

test('reviewing writes who and when, and leaves a note if given', async () => {
  const db = fakeDb(rowsFor);
  const result = await reviewUnproven(db, { unproven_id: 'unproven:1', staff_id: 'staff:dean', note: 'checked, fine' });
  assert.equal(result.reviewed_by, 'staff:dean');
  const update = db.batches[0][0].call;
  assert.match(update.sql, /SET reviewed_at = datetime\('now'\), reviewed_by = \?, review_note = \?/);
  assert.deepEqual(update.params, ['staff:dean', 'checked, fine', 'unproven:1']);
});

test('an unknown unproven id is refused', async () => {
  const db = fakeDb(() => []);
  await assert.rejects(
    () => reviewUnproven(db, { unproven_id: 'unproven:ghost', staff_id: 'staff:dean' }),
    /unknown unproven input/,
  );
});
