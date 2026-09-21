import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import worker from '../src/index.js';
import { login, makePinRow } from '../src/auth.js';
import { sqliteDb } from './sqliteDb.js';

const get = (path) => new Request(`https://localhost${path}`);

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
  const res = await worker.fetch(new Request('https://localhost/api/catalog', { method: 'POST' }), env);
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
  // Signed in first: a write with no token is refused as a 401 before its body
  // is looked at, which is its own test in auth.test.js.
  const db = sqliteDb();
  db.sqlite.exec("INSERT INTO staff (id, name) VALUES ('s1', 'Dean')");
  const env = { DB: db, AUTH_SECRET: 'a'.repeat(40), PIN_PEPPER: 'b'.repeat(40) };
  const pin = await makePinRow(env, '4821');
  db.sqlite.prepare('INSERT INTO staff_pins (staff_id, pin_hash, salt) VALUES (?, ?, ?)').run('s1', pin.pin_hash, pin.salt);
  const { token } = await login(db, env, { staff_id: 's1', pin: '4821' });

  const request = new Request('https://localhost/api/receive', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'not json',
  });
  const res = await worker.fetch(request, env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /valid JSON/);
});

test('tracing with no lot is a 400', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(get('/api/trace'), env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /lot is required/);
});

test('tracing is a read, so a POST to it is refused', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(new Request('https://trace.example/api/trace', { method: 'POST' }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

test('a recall with no lot is a 400, and with a bad direction is a 400', async () => {
  const env = { DB: fakeDb(() => []) };
  const none = await worker.fetch(get('/api/recall'), env);
  assert.equal(none.status, 400);
  assert.match((await none.json()).error, /lot is required/);
  const bad = await worker.fetch(get('/api/recall?lot=x&direction=sideways'), env);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /direction must be one of/);
});

test('a recall is a read, so a POST to it is refused', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(new Request('https://trace.example/api/recall', { method: 'POST' }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

test('a balance with no dates is a 400 that says which', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(get('/api/period-balance'), env);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /from must be a date/);
});

test('a balance is a read, so a POST to it is refused', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(new Request('https://trace.example/api/period-balance', { method: 'POST' }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET');
});

test('the bundled alert view answers with every category, even with nothing open', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(get('/api/alerts'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    deviations: [], holds: [], unproven: [], unresourced: [],
    negative_balances: [], conflicting_dates: [], total: 0,
  });
});

test('an unknown path is a 404 that names the endpoints', async () => {
  const env = { DB: fakeDb(() => []) };
  const res = await worker.fetch(get('/api/nope'), env);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /\/api\/catalog/);
});
