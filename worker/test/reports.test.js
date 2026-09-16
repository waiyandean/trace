import test from 'node:test';
import assert from 'node:assert/strict';
import { traceLot, negativeBalances, conflictingDates, alerts } from '../src/ledger/reports.js';

// A minimal fake covering only what reports.js reads: a lot lookup, the two
// genealogy edges, and the two new scans. Everything reports.js bundles from
// elsewhere (deviations, holds, unproven, unresourced count lines) is stubbed
// as empty here and left to that module's own tests.
function reportsDb({ lot = null, back = [], forward = [], negative = [], conflicting = [] } = {}) {
  return {
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async first() {
          if (sql.includes('FROM lots l JOIN items i ON i.id = l.item_id WHERE l.id')) return lot;
          return null;
        },
        async all() {
          if (sql.includes("m.counterpart_lot_id = ? AND m.type = 'CONSUME'")) return { results: back };
          if (sql.includes("m.lot_id = ? AND m.type = 'CONSUME'")) return { results: forward };
          if (sql.includes('b.quantity < 0')) return { results: negative };
          if (sql.includes('date(l.use_by) <= date(l.originated_at)')) return { results: conflicting };
          return { results: [] };
        },
      };
      return statement;
    },
  };
}

test('tracing an unknown lot is a BadRequest, not a null crash', async () => {
  const db = reportsDb({ lot: null });
  await assert.rejects(() => traceLot(db, 'lot:ghost'), /no lot "lot:ghost"/);
});

test('tracing with no lot id is a BadRequest', async () => {
  const db = reportsDb();
  await assert.rejects(() => traceLot(db, null), /lot is required/);
});

test('one step back and one step forward come back separately', async () => {
  const lot = { id: 'lot:broth', item_name: 'Tonkotsu Broth', base_unit: 'L' };
  const back = [{ id: 'lot:carcass', item_name: 'Chicken Carcass', quantity: 8 }];
  const forward = [{ id: 'lot:dispatch1', item_name: 'Tonkotsu Broth', quantity: 4 }];
  const db = reportsDb({ lot, back, forward });

  const result = await traceLot(db, 'lot:broth');
  assert.deepEqual(result.lot, lot);
  assert.deepEqual(result.back, back);
  assert.deepEqual(result.forward, forward);
});

test('negative balances passes the scan straight through', async () => {
  const rows = [{ lot_id: 'lot:x', item_name: 'Chilli Oil', location_name: 'Dry Store', quantity: -2 }];
  const db = reportsDb({ negative: rows });
  assert.deepEqual(await negativeBalances(db), rows);
});

test('conflicting dates passes the scan straight through', async () => {
  const rows = [{
    lot_id: 'lot:y', item_name: 'Coconut Milk', use_by: '2026-09-01', originated_at: '2026-09-05',
  }];
  const db = reportsDb({ conflicting: rows });
  assert.deepEqual(await conflictingDates(db), rows);
});

test('the bundled alert view totals every category, even when all are empty', async () => {
  const db = reportsDb();
  const result = await alerts(db);
  assert.equal(result.total, 0);
  assert.deepEqual(result.deviations, []);
  assert.deepEqual(result.holds, []);
  assert.deepEqual(result.unproven, []);
  assert.deepEqual(result.unresourced, []);
  assert.deepEqual(result.negative_balances, []);
  assert.deepEqual(result.conflicting_dates, []);
});

test('the bundled alert view counts what the two new scans found', async () => {
  const db = reportsDb({
    negative: [{ lot_id: 'lot:x' }],
    conflicting: [{ lot_id: 'lot:y' }, { lot_id: 'lot:z' }],
  });
  const result = await alerts(db);
  assert.equal(result.negative_balances.length, 1);
  assert.equal(result.conflicting_dates.length, 2);
  assert.equal(result.total, 3);
});
