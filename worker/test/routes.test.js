import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import worker from '../src/index.js';

const get = (path) => new Request(`https://trace.example${path}`);

test('health reports the item count', async () => {
  const env = { DB: fakeDb(() => [{ items: 42 }]) };
  const res = await worker.fetch(get('/api/health'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, items: 42 });
});

test('a catalog read returns the rows', async () => {
  const env = { DB: fakeDb(() => [{ id: 'l1', name: 'Walk-in chill', kind: 'chill', active: 1 }]) };
  const res = await worker.fetch(get('/api/catalog?action=locations'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.action, 'locations');
  assert.equal(body.rows[0].active, true);
});

test('a bad action is a 400 with the reason', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(get('/api/catalog?action=lots'), env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown action: lots/);
});

test('P0 is read-only: writes are refused', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(new Request('https://trace.example/api/catalog', { method: 'POST' }), env);
  assert.equal(res.status, 405);
});

test('an unknown path is a 404 that names the endpoints', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(get('/api/nope'), env);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /\/api\/catalog/);
});
