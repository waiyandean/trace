import test from 'node:test';
import assert from 'node:assert/strict';
import { afterOpening, recordOpening } from '../src/ledger/opening.js';

// afterOpening: the rule from PLAN.md's open item 4 ("Opening a pack",
// Dean, 2026-08-31) — shortens takes the earlier of the pack's own date and
// days-after-opening; no_change leaves the use-by exactly as it was.

test('shortens takes the earlier of the printed date and days-after-opening', () => {
  const r = afterOpening('shortens', '2026-12-01', '2026-09-17', 42);
  assert.equal(r.useBy, '2026-10-29');
  assert.equal(r.source, 'opened_rule');
});

test('shortens leaves the use-by alone when the printed date is already sooner', () => {
  const r = afterOpening('shortens', '2026-09-20', '2026-09-17', 42);
  assert.equal(r.useBy, '2026-09-20');
  assert.equal(r.source, null, 'nothing changed, so nothing needs writing');
});

test('shortens with no printed date at all just applies the days', () => {
  const r = afterOpening('shortens', null, '2026-09-17', 7);
  assert.equal(r.useBy, '2026-09-24');
  assert.equal(r.source, 'opened_rule');
});

test('no_change leaves the use-by exactly as it was', () => {
  const r = afterOpening('no_change', '2026-12-01', '2026-09-17', 999);
  assert.equal(r.useBy, '2026-12-01');
  assert.equal(r.source, null);
});

// ---------------------------------------------------------- recordOpening

function openingDb({ lot } = {}) {
  const state = {
    staff: { 'staff:nikin': { id: 'staff:nikin', name: 'Nikin', active: 1 } },
    events: {},
    lot: lot ?? {
      id: 'lot:hoisin', status: 'open', opened_at: null, use_by: '2027-01-01',
      short_code: 'ABCDEF', batch_code: '160926', item_id: 'item:hoisin', item_name: 'Hoi Sin Sauce 20kg',
      kind: 'ingredient', base_unit: 'kg', opening_rule: 'shortens', days_after_opening: 42, storage_opened: 'chill',
    },
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
          if (sql.includes('FROM staff')) return state.staff[id] ?? null;
          if (sql.includes('FROM events')) return state.events[id] ?? null;
          if (sql.includes('FROM lots l JOIN items i')) return id === state.lot.id ? state.lot : null;
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

const note = (changes = {}) => ({
  event_id: '01HZZZZZZZZZZZZZZZZZZZZZZZ', idempotency_key: 'open-00000000000001', staff_id: 'staff:nikin',
  occurred_at: '2026-09-17T10:00:00Z', lot_id: 'lot:hoisin', opened_on: '2026-09-17',
  ...changes,
});

test('opening a shortens-rule lot updates use_by and records the source', async () => {
  const db = openingDb();
  const result = await recordOpening(db, note());
  assert.equal(result.duplicate, false);
  assert.equal(result.use_by, '2026-10-29');
  const update = db.written.find((s) => s.sql.includes('UPDATE lots'));
  assert.match(update.sql, /use_by = \?, use_by_source = \?/);
});

test('opening a no_change-rule lot only stamps opened_at, not use_by', async () => {
  const db = openingDb({
    lot: {
      id: 'lot:msg', status: 'open', opened_at: null, use_by: '2027-01-01', short_code: 'GHIJKL',
      batch_code: '160926', item_id: 'item:msg', item_name: "Aji-no-Moto MSG", kind: 'ingredient',
      base_unit: 'kg', opening_rule: 'no_change', days_after_opening: null, storage_opened: 'ambient',
    },
  });
  const result = await recordOpening(db, note({ lot_id: 'lot:msg' }));
  assert.equal(result.use_by, '2027-01-01');
  const update = db.written.find((s) => s.sql.includes('UPDATE lots'));
  assert.doesNotMatch(update.sql, /use_by/);
  assert.match(update.sql, /opened_at = \?/);
});

test('a whole_pack item is refused — there is no Date Opened label for it', async () => {
  const db = openingDb({
    lot: {
      id: 'lot:salt', status: 'open', opened_at: null, use_by: null, short_code: 'AAAAAA',
      batch_code: '160926', item_id: 'item:salt', item_name: 'Table Salt', kind: 'ingredient',
      base_unit: 'kg', opening_rule: 'whole_pack', days_after_opening: null, storage_opened: 'ambient',
    },
  });
  await assert.rejects(() => recordOpening(db, note({ lot_id: 'lot:salt' })), /used whole/);
});

test('a lot already opened is refused, not silently reopened', async () => {
  const db = openingDb({
    lot: {
      id: 'lot:hoisin', status: 'open', opened_at: '2026-09-01T10:00:00Z', use_by: '2026-10-13',
      short_code: 'ABCDEF', batch_code: '160926', item_id: 'item:hoisin', item_name: 'Hoi Sin Sauce 20kg',
      kind: 'ingredient', base_unit: 'kg', opening_rule: 'shortens', days_after_opening: 42, storage_opened: 'chill',
    },
  });
  await assert.rejects(() => recordOpening(db, note()), /already opened/);
});

test('a held lot cannot be opened', async () => {
  const db = openingDb({
    lot: {
      id: 'lot:hoisin', status: 'held', opened_at: null, use_by: '2027-01-01', short_code: 'ABCDEF',
      batch_code: '160926', item_id: 'item:hoisin', item_name: 'Hoi Sin Sauce 20kg', kind: 'ingredient',
      base_unit: 'kg', opening_rule: 'shortens', days_after_opening: 42, storage_opened: 'chill',
    },
  });
  await assert.rejects(() => recordOpening(db, note()), /held, not open/);
});

test('a product cannot be marked opened — the rule is ingredients only', async () => {
  const db = openingDb({
    lot: {
      id: 'lot:broth', status: 'open', opened_at: null, use_by: '2027-09-01', short_code: 'ABCDEF',
      batch_code: '1609GA1', item_id: 'item:broth', item_name: 'Chicken Broth', kind: 'product',
      base_unit: 'L', opening_rule: null, days_after_opening: null, storage_opened: 'freezer',
    },
  });
  await assert.rejects(() => recordOpening(db, note({ lot_id: 'lot:broth' })), /not an ingredient/);
});

test('an unknown lot is refused by name', async () => {
  const db = openingDb();
  await assert.rejects(() => recordOpening(db, note({ lot_id: 'lot:ghost' })), /unknown lot/);
});
