import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import worker from '../src/index.js';

const get = (path) => new Request(`https://trace.example${path}`);

test('health reports what the database holds', async () => {
  const env = { DB: fakeDb(() => [{ items: 42, lots: 3 }]) };
  const res = await worker.fetch(get('/api/health'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, items: 42, lots: 3 });
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

test('the catalog is read-only: a write to it is refused and says what to use', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(new Request('https://trace.example/api/catalog', { method: 'POST' }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

test('receiving is a write, so a GET of it is refused the same way', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(get('/api/receive'), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
});

test('a ledger read returns the rows', async () => {
  const env = { DB: fakeDb(() => [{ id: 'lot1', item_name: 'Chicken Carcass', quantity: 24 }]) };
  const res = await worker.fetch(get('/api/ledger?action=lots'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.action, 'lots');
  assert.equal(body.rows[0].quantity, 24);
});

test('an unknown lot status is a 400 rather than an empty list', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(get('/api/ledger?action=lots&status=frozen'), env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown lot status: frozen/);
});

test('a code that matches nothing says so rather than guessing', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(get('/api/lookup?code=ZZZZZZ'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { code: 'ZZZZZZ', matched: null, lots: [] });
});

test('a body that is not JSON is a 400, not a crash', async () => {
  const env = { DB: fakeDb(() => []) };
  const request = new Request('https://trace.example/api/receive', { method: 'POST', body: 'not json' });
  const res = await worker.fetch(request, env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /valid JSON/);
});

test('an unknown path is a 404 that names the endpoints', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(get('/api/nope'), env);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /\/api\/catalog/);
});
