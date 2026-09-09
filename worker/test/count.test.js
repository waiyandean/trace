import test from 'node:test';
import assert from 'node:assert/strict';
import { recordCount, resolveCountLine } from '../src/ledger/count.js';

// A database holding one staff member, one item measured in kg, two storage
// areas (one retired), and a ledger of two open lots of that item in the
// fridge — 20 kg and 10 kg, 30 kg between them.
function countDb(overrides = {}) {
  const state = {
    staff: { 'staff:nikin': { id: 'staff:nikin', name: 'Nikin', active: 1 } },
    items: { 'item:hoisin': { id: 'item:hoisin', name: 'Hoi Sin Sauce', base_unit: 'kg' } },
    locations: {
      'loc:fridge': { id: 'loc:fridge', name: 'Walk In Fridge', active: 1 },
      'loc:old': { id: 'loc:old', name: 'Old Store', active: 0 },
    },
    // (item@location) -> the per-lot balances the ledger computes there
    ledger: {
      'item:hoisin@loc:fridge': [
        { lot_id: 'lot:a', status: 'open', quantity: 20 },
        { lot_id: 'lot:b', status: 'open', quantity: 10 },
      ],
    },
    countLines: {},
    events: {},
    ...overrides,
  };

  const written = [];
  return {
    state,
    written,
    async batch(statements) {
      for (const s of statements) {
        if (s.sql.includes('INSERT INTO events')) {
          const [id, , key, hash] = s.params;
          state.events[key] = { id, payload_hash: hash };
        }
      }
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
          const [a] = statement.params;
          if (sql.includes('FROM events')) return state.events[a] ?? null;
          if (sql.includes('FROM staff')) return state.staff[a] ?? null;
          if (sql.includes('FROM items WHERE id')) return state.items[a] ?? null;
          if (sql.includes('FROM locations')) return state.locations[a] ?? null;
          if (sql.includes('FROM count_lines WHERE id')) return state.countLines[a] ?? null;
          return null;
        },
        async all() {
          if (sql.includes('JOIN movements m')) {
            const [itemId, locationId] = statement.params;
            return { results: state.ledger[`${itemId}@${locationId}`] ?? [] };
          }
          return { results: [] };
        },
      };
      return statement;
    },
  };
}

const sheet = (changes = {}) => ({
  event_id: '01J8XQZ5T7M4QPB9CDEFGHJKMP',
  idempotency_key: 'count-0001',
  staff_id: 'staff:nikin',
  occurred_at: '2026-09-08T18:00:00Z',
  lines: [{ item_id: 'item:hoisin', location_id: 'loc:fridge', counted_quantity: 30 }],
  ...changes,
});

const sqlOf = (db, fragment) => db.written.filter((s) => s.sql.includes(fragment));
const movements = (db) => sqlOf(db, "INSERT INTO movements");
const lineRows = (db) => sqlOf(db, 'INSERT INTO count_lines');

test('a count that matches the ledger writes the sheet and no movements', async () => {
  const db = countDb();
  const result = await recordCount(db, sheet());
  assert.equal(result.duplicate, false);
  assert.equal(movements(db).length, 0);
  const line = lineRows(db)[0].params;
  assert.equal(line[7], 30, 'ledger figure recorded');
  assert.equal(line[8], 0, 'no variance');
  assert.equal(line[9], 'no_variance');
});

test('a shortfall is split across the lots pro-rata by balance, one negative ADJUST each', async () => {
  const db = countDb();
  await recordCount(db, sheet({ lines: [{ item_id: 'item:hoisin', location_id: 'loc:fridge', counted_quantity: 24 }] }));

  const rows = movements(db);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row.sql, /'ADJUST'/);

  const byLot = Object.fromEntries(rows.map((r) => [r.params[1], r.params]));
  // variance -6 over 20:10 -> -4 and -2
  assert.equal(byLot['lot:a'][2], -4);
  assert.equal(byLot['lot:b'][2], -2);
  // negative: from_location set, to_location null
  assert.equal(byLot['lot:a'][3], 'loc:fridge');
  assert.equal(byLot['lot:a'][4], null);

  assert.equal(lineRows(db)[0].params[9], 'apportioned');
});

test('a surplus apportions positive ADJUSTs, landing in the location', async () => {
  const db = countDb();
  await recordCount(db, sheet({ lines: [{ item_id: 'item:hoisin', location_id: 'loc:fridge', counted_quantity: 40 }] }));

  const rows = movements(db);
  const total = rows.reduce((sum, r) => sum + r.params[2], 0);
  assert.ok(Math.abs(total - 10) < 1e-12, 'the shares add back to the +10 variance');
  for (const row of rows) {
    assert.ok(row.params[2] > 0);
    assert.equal(row.params[3], null, 'positive: no from-location');
    assert.equal(row.params[4], 'loc:fridge', 'positive: lands in the counted location');
  }
});

test('pro-rata by a positive balance cannot drive a lot below zero', async () => {
  const db = countDb();
  await recordCount(db, sheet({ lines: [{ item_id: 'item:hoisin', location_id: 'loc:fridge', counted_quantity: 0 }] }));

  const byLot = Object.fromEntries(movements(db).map((r) => [r.params[1], r.params[2]]));
  assert.equal(byLot['lot:a'], -20, 'exactly its own balance, not more');
  assert.equal(byLot['lot:b'], -10);
});

test('the rounding remainder lands on the largest lot so the shares sum to the variance exactly', async () => {
  const db = countDb({
    ledger: {
      'item:hoisin@loc:fridge': [
        { lot_id: 'lot:a', status: 'open', quantity: 10 },
        { lot_id: 'lot:b', status: 'open', quantity: 10 },
        { lot_id: 'lot:c', status: 'open', quantity: 10 },
      ],
    },
  });
  await recordCount(db, sheet({ lines: [{ item_id: 'item:hoisin', location_id: 'loc:fridge', counted_quantity: 20 }] }));

  const rows = movements(db);
  assert.equal(rows.length, 3);
  const total = rows.reduce((sum, r) => sum + r.params[2], 0);
  assert.ok(Math.abs(total - -10) < 1e-12);
});

test('stock counted with no open lot to carry it is recorded unresourced, with nothing written', async () => {
  const db = countDb({ ledger: {} });
  await recordCount(db, sheet({ lines: [{ item_id: 'item:hoisin', location_id: 'loc:fridge', counted_quantity: 5 }] }));

  assert.equal(movements(db).length, 0);
  const line = lineRows(db)[0].params;
  assert.equal(line[7], 0, 'ledger knows of none');
  assert.equal(line[8], 5, 'the whole counted quantity is the variance');
  assert.equal(line[9], 'unresourced');
});

test('a resent count writes nothing a second time', async () => {
  const db = countDb();
  await recordCount(db, sheet());
  const after = db.written.length;
  const replay = await recordCount(db, sheet());
  assert.equal(replay.duplicate, true);
  assert.equal(db.written.length, after, 'no second write');
});

test('the same key with different lines is refused, not treated as a duplicate', async () => {
  const db = countDb();
  await recordCount(db, sheet());
  await assert.rejects(
    () => recordCount(db, sheet({ lines: [{ item_id: 'item:hoisin', location_id: 'loc:fridge', counted_quantity: 99 }] })),
    /was already used for a different submission/,
  );
});

test('the same item in the same place twice on one sheet is refused', async () => {
  const db = countDb();
  await assert.rejects(
    () => recordCount(db, sheet({
      lines: [
        { item_id: 'item:hoisin', location_id: 'loc:fridge', counted_quantity: 10 },
        { item_id: 'item:hoisin', location_id: 'loc:fridge', counted_quantity: 20 },
      ],
    })),
    /counted twice in the same place/,
  );
});

test('a count of nothing is not a count', async () => {
  const db = countDb();
  await assert.rejects(() => recordCount(db, sheet({ lines: [] })), /a count of nothing is not a count/);
});

test('a retired storage area cannot be counted', async () => {
  const db = countDb();
  await assert.rejects(
    () => recordCount(db, sheet({ lines: [{ item_id: 'item:hoisin', location_id: 'loc:old', counted_quantity: 1 }] })),
    /is not an active location/,
  );
});

test('a negative counted quantity is refused', async () => {
  const db = countDb();
  await assert.rejects(
    () => recordCount(db, sheet({ lines: [{ item_id: 'item:hoisin', location_id: 'loc:fridge', counted_quantity: -1 }] })),
    /must be a number of zero or more/,
  );
});

test('resolving an unresourced line records who and when', async () => {
  const db = countDb({ countLines: { 'cl-1': { id: 'cl-1', disposition: 'unresourced', resolved_at: null } } });
  const result = await resolveCountLine(db, { line_id: 'cl-1', staff_id: 'staff:nikin', note: 'delivery found, lot opened' });
  assert.equal(result.resolved_by, 'Nikin');
  const update = sqlOf(db, 'UPDATE count_lines')[0].params;
  assert.deepEqual(update, ['staff:nikin', 'delivery found, lot opened', 'cl-1']);
});

test('a line that balanced itself has nothing to resolve', async () => {
  const db = countDb({ countLines: { 'cl-2': { id: 'cl-2', disposition: 'apportioned', resolved_at: null } } });
  await assert.rejects(
    () => resolveCountLine(db, { line_id: 'cl-2', staff_id: 'staff:nikin' }),
    /nothing to close/,
  );
});

test('an already-resolved line cannot be resolved twice', async () => {
  const db = countDb({
    countLines: { 'cl-3': { id: 'cl-3', disposition: 'unresourced', resolved_at: '2026-09-09T10:00:00Z' } },
  });
  await assert.rejects(
    () => resolveCountLine(db, { line_id: 'cl-3', staff_id: 'staff:nikin' }),
    /already resolved/,
  );
});
