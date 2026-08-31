import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import { handleCatalog, getItems, getConversions } from '../src/catalog/handlers.js';
import { BadRequest } from '../src/http.js';

const catalogUrl = (query) => new URL(`https://trace.example/api/catalog?${query}`);

test('items default to active rows only, ordered by name', async () => {
  const db = fakeDb(() => []);
  await getItems(db);
  assert.equal(db.calls[0].sql, 'SELECT * FROM items WHERE active = 1 ORDER BY name');
  assert.deepEqual(db.calls[0].params, []);
});

test('active=all drops the active filter', async () => {
  const db = fakeDb(() => []);
  await handleCatalog(db, catalogUrl('action=items&active=all'));
  assert.equal(db.calls[0].sql, 'SELECT * FROM items ORDER BY name');
});

test('kind is bound as a parameter, not interpolated', async () => {
  const db = fakeDb(() => []);
  await getItems(db, { kind: 'product' });
  assert.equal(db.calls[0].sql, 'SELECT * FROM items WHERE active = 1 AND kind = ? ORDER BY name');
  assert.deepEqual(db.calls[0].params, ['product']);
});

test('an unknown kind is rejected rather than queried', async () => {
  const db = fakeDb(() => []);
  await assert.rejects(() => getItems(db, { kind: 'nonsense' }), BadRequest);
  assert.equal(db.calls.length, 0);
});

test('the 0/1 flag columns come back as booleans', async () => {
  const db = fakeDb(() => [
    { id: 'i1', name: 'Chicken feet', kind: 'ingredient', active: 1, needs_health_mark: null },
    { id: 'i2', name: 'Tonkotsu broth', kind: 'product', active: 1, needs_health_mark: 1 },
    { id: 'i3', name: 'Chilli oil', kind: 'product', active: 0, needs_health_mark: 0 },
  ]);
  const { rows, count } = await handleCatalog(db, catalogUrl('action=items&active=all'));
  assert.equal(count, 3);
  assert.deepEqual(
    rows.map((r) => [r.active, r.needs_health_mark]),
    [[true, null], [true, true], [false, false]],
  );
});

test('conversions filter by item and join the item name', async () => {
  const db = fakeDb(() => []);
  await getConversions(db, { itemId: 'i1' });
  assert.match(db.calls[0].sql, /WHERE c\.item_id = \?/);
  assert.match(db.calls[0].sql, /JOIN items i ON i\.id = c\.item_id/);
  assert.deepEqual(db.calls[0].params, ['i1']);
});

test('a missing or unknown action is a BadRequest, not a query', async () => {
  const db = fakeDb(() => []);
  await assert.rejects(() => handleCatalog(db, catalogUrl('')), BadRequest);
  await assert.rejects(() => handleCatalog(db, catalogUrl('action=lots')), BadRequest);
  assert.equal(db.calls.length, 0);
});
