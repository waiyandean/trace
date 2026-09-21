import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  login, authenticate, whoami, changePin, makePinRow, weakness,
  MAX_ATTEMPTS, TOKEN_TTL_S, QUEUE_GRACE_S,
} from '../src/auth.js';
import { AuthError, BadRequest } from '../src/http.js';
import { sqliteDb } from './sqliteDb.js';

const T0 = Date.parse('2026-09-21T06:00:00Z');
const H = 3600 * 1000;

async function world() {
  const db = sqliteDb();
  const env = { DB: db, AUTH_SECRET: 'a'.repeat(40), PIN_PEPPER: 'b'.repeat(40) };
  db.sqlite.exec(`
    INSERT INTO staff (id, name) VALUES ('dean', 'Dean'), ('nikin', 'Nikin'), ('nopin', 'Nopin');
    INSERT INTO staff (id, name, active) VALUES ('gone', 'Gone', 0);
  `);
  for (const [id, pin] of [['dean', '4821'], ['nikin', '4821'], ['gone', '7391']]) {
    const row = await makePinRow(env, pin);
    db.sqlite.prepare('INSERT INTO staff_pins (staff_id, pin_hash, salt) VALUES (?, ?, ?)')
      .run(id, row.pin_hash, row.salt);
  }
  return { db, env };
}

const request = (token, body = {}, path = '/x') => new Request(`https://t.example${path}`, {
  method: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body),
});

async function signIn(env, db, at = T0, staff = 'dean', pin = '4821') {
  return (await login(db, env, { staff_id: staff, pin }, at)).token;
}

const refused = (status, pattern) => (err) => err instanceof AuthError && err.status === status && pattern.test(err.message);

// ---------------------------------------------------------------- signing in

test('the right PIN gives a token that says who it is', async () => {
  const { db, env } = await world();
  const result = await login(db, env, { staff_id: 'dean', pin: '4821' }, T0);
  assert.equal(result.staff.name, 'Dean');
  assert.equal(result.expires_at, T0 + TOKEN_TTL_S * 1000);
  const who = await whoami(db, env, request(result.token), T0 + H);
  assert.equal(who.staff.id, 'dean');
});

test('a wrong PIN says how many tries are left, and five lock the person out', async () => {
  const { db, env } = await world();
  await assert.rejects(() => login(db, env, { staff_id: 'dean', pin: '0000' }, T0), refused(401, /4 tries left/));
  for (let i = 0; i < MAX_ATTEMPTS - 2; i += 1) {
    await assert.rejects(() => login(db, env, { staff_id: 'dean', pin: '0000' }, T0), refused(401, /tr(y|ies) left/));
  }
  await assert.rejects(() => login(db, env, { staff_id: 'dean', pin: '0000' }, T0), refused(429, /try again in 10 min/));
});

test('while locked out even the right PIN is refused, and the lock is not extended', async () => {
  const { db, env } = await world();
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) await login(db, env, { staff_id: 'dean', pin: '0000' }, T0).catch(() => {});
  await assert.rejects(() => login(db, env, { staff_id: 'dean', pin: '4821' }, T0 + 5 * 60000), refused(429, /min/));
  const result = await login(db, env, { staff_id: 'dean', pin: '4821' }, T0 + 11 * 60000);
  assert.ok(result.token, 'ten minutes on the right PIN works');
});

test('a lockout carries a Retry-After the caller can read', async () => {
  const { db, env } = await world();
  let last;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) last = await login(db, env, { staff_id: 'dean', pin: '0000' }, T0).catch((e) => e);
  assert.equal(last.retryAfter, 600);
});

test('a repeat lockout doubles, and a success clears the count', async () => {
  const { db, env } = await world();
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) await login(db, env, { staff_id: 'dean', pin: '0000' }, T0).catch(() => {});
  let second;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    second = await login(db, env, { staff_id: 'dean', pin: '0000' }, T0 + 11 * 60000).catch((e) => e);
  }
  assert.equal(second.retryAfter, 1200, 'the second lockout is twenty minutes');

  const later = T0 + 60 * 60000;
  await login(db, env, { staff_id: 'dean', pin: '4821' }, later);
  const row = db.sqlite.prepare("SELECT failed_count, lock_level FROM staff_pins WHERE staff_id = 'dean'").get();
  assert.equal(row.failed_count, 0);
  assert.equal(row.lock_level, 0);
});

test('one person being locked out does not lock anybody else', async () => {
  const { db, env } = await world();
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) await login(db, env, { staff_id: 'dean', pin: '0000' }, T0).catch(() => {});
  assert.ok((await login(db, env, { staff_id: 'nikin', pin: '4821' }, T0)).token);
});

test('nobody can sign in without a PIN set, or once they are no longer active', async () => {
  const { db, env } = await world();
  await assert.rejects(() => login(db, env, { staff_id: 'nopin', pin: '4821' }, T0), refused(401, /no PIN is set for Nopin/));
  await assert.rejects(() => login(db, env, { staff_id: 'gone', pin: '7391' }, T0), refused(403, /no longer active/));
  await assert.rejects(() => login(db, env, { staff_id: 'ghost', pin: '4821' }, T0), BadRequest);
});

test('a PIN must be exactly four digits', async () => {
  const { db, env } = await world();
  for (const pin of ['123', '12345', 'abcd', '', null]) {
    await assert.rejects(() => login(db, env, { staff_id: 'dean', pin }, T0), /exactly four digits/);
  }
});

// ------------------------------------------------------------------ storage

test('the PIN is not stored, and two people with the same PIN do not share a hash', async () => {
  const { db } = await world();
  const rows = db.sqlite.prepare('SELECT staff_id, pin_hash, salt FROM staff_pins').all();
  for (const row of rows) assert.ok(!row.pin_hash.includes('4821') && !row.salt.includes('4821'));
  const [dean, nikin] = ['dean', 'nikin'].map((id) => rows.find((r) => r.staff_id === id));
  assert.notEqual(dean.pin_hash, nikin.pin_hash, 'same PIN, different salt');
});

test('a copy of the database is no use without the pepper', async () => {
  const { db, env } = await world();
  const other = { ...env, PIN_PEPPER: 'c'.repeat(40) };
  await assert.rejects(() => login(db, other, { staff_id: 'dean', pin: '4821' }, T0), refused(401, /wrong PIN/));
});

// ------------------------------------------------------------- weak PINs

test('repeats and straight runs are weak, ordinary PINs are not', () => {
  for (const pin of ['0000', '7777', '1234', '4321', '6789', '9876', '0123']) assert.ok(weakness(pin), pin);
  for (const pin of ['4821', '1357', '2580', '1212', '1004']) assert.equal(weakness(pin), null, pin);
});

// --------------------------------------------------------- what a write needs

test('a write with no token, or a bad one, is refused before its body is read', async () => {
  const { db, env } = await world();
  const noBody = () => { throw new Error('body must not be read'); };
  const bare = new Request('https://t.example/x', { method: 'POST' });
  await assert.rejects(() => authenticate(db, env, bare, noBody, T0), refused(401, /sign in first/));
  const junk = new Request('https://t.example/x', { method: 'POST', headers: { authorization: 'Bearer not.a.token' } });
  await assert.rejects(() => authenticate(db, env, junk, noBody, T0), refused(401, /not valid/));
});

test('a token with its contents changed is refused', async () => {
  const { db, env } = await world();
  const token = await signIn(env, db);
  const [body, sig] = token.split('.');
  const claims = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
  claims.sub = 'nikin';
  const forged = `${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.${sig}`;
  await assert.rejects(() => authenticate(db, env, request(forged), async () => ({}), T0 + H), refused(401, /not valid/));
});

test('the person comes from the token, and the body cannot say otherwise', async () => {
  const { db, env } = await world();
  const token = await signIn(env, db);

  const bare = { lot_id: 'x' };
  await authenticate(db, env, request(token), async () => bare, T0 + H);
  assert.equal(bare.staff_id, 'dean', 'set when the body names nobody');

  const same = { staff_id: 'dean' };
  await authenticate(db, env, request(token), async () => same, T0 + H);
  assert.equal(same.staff_id, 'dean');

  await assert.rejects(
    () => authenticate(db, env, request(token), async () => ({ staff_id: 'nikin' }), T0 + H),
    refused(403, /signed in as Dean/),
  );
});

test('a token stops working when the person is made inactive', async () => {
  const { db, env } = await world();
  const token = await signIn(env, db);
  db.sqlite.exec("UPDATE staff SET active = 0 WHERE id = 'dean'");
  await assert.rejects(() => authenticate(db, env, request(token), async () => ({}), T0 + H), refused(403, /no longer active/));
});

// ---------------------------------------------------- offline, and the clock

test('a delivery keyed while signed in is accepted after the token expired, if it was made in time', async () => {
  const { db, env } = await world();
  const token = await signIn(env, db);
  const body = { occurred_at: new Date(T0 + 1 * H).toISOString() };
  await authenticate(db, env, request(token), async () => body, T0 + 20 * H);
  assert.equal(body.staff_id, 'dean', 'made at 07:00, sent at 02:00 the next morning');
});

test('something made after the token expired is refused, however it arrives', async () => {
  const { db, env } = await world();
  const token = await signIn(env, db);
  const late = { occurred_at: new Date(T0 + (TOKEN_TTL_S + 3600) * 1000).toISOString() };
  await assert.rejects(() => authenticate(db, env, request(token), async () => late, T0 + 20 * H), refused(401, /run out/));
  await assert.rejects(() => authenticate(db, env, request(token), async () => ({}), T0 + 13 * H), refused(401, /run out/),
    'no occurred_at means now');
});

test('something claimed to be made before signing in is refused', async () => {
  const { db, env } = await world();
  const token = await signIn(env, db);
  const early = { occurred_at: new Date(T0 - 2 * H).toISOString() };
  await assert.rejects(() => authenticate(db, env, request(token), async () => early, T0 + H), refused(401, /before you signed in/));
});

test('a future time cannot stretch a token past its life', async () => {
  const { db, env } = await world();
  const token = await signIn(env, db);
  // Sent at 19:00, twelve hours after the token was issued at 06:00 and past
  // its expiry, claiming to have been made a day from now.
  const future = { occurred_at: new Date(T0 + 40 * H).toISOString() };
  await assert.rejects(() => authenticate(db, env, request(token), async () => future, T0 + 13 * H), refused(401, /run out/),
    'the claimed time is clamped to now, which is after expiry');
});

test('an expired token is not good for ever, even for something made while it was valid', async () => {
  const { db, env } = await world();
  const token = await signIn(env, db);
  const body = { occurred_at: new Date(T0 + H).toISOString() };
  const tooLate = T0 + (TOKEN_TTL_S + QUEUE_GRACE_S + 60) * 1000;
  await assert.rejects(() => authenticate(db, env, request(token), async () => body, tooLate), refused(401, /too old/));
});

// ------------------------------------------------------------- fail closed

test('with either secret missing nothing can sign in or record anything', async () => {
  const { db, env } = await world();
  const token = await signIn(env, db);
  for (const broken of [{ ...env, AUTH_SECRET: undefined }, { ...env, PIN_PEPPER: 'short' }]) {
    await assert.rejects(() => login(db, broken, { staff_id: 'dean', pin: '4821' }, T0), refused(503, /not set up/));
    await assert.rejects(() => authenticate(db, broken, request(token), async () => ({}), T0 + H), refused(503, /not set up/));
  }
});

// ----------------------------------------------------------- changing a PIN

test('changing your PIN takes the old one, and the old one stops working', async () => {
  const { db, env } = await world();
  await changePin(db, env, { staff_id: 'dean', old_pin: '4821', new_pin: '9153' }, T0);
  await assert.rejects(() => login(db, env, { staff_id: 'dean', pin: '4821' }, T0), refused(401, /wrong PIN/));
  assert.ok((await login(db, env, { staff_id: 'dean', pin: '9153' }, T0)).token);
});

test('a wrong old PIN counts against the lockout, and a weak new one is refused', async () => {
  const { db, env } = await world();
  await assert.rejects(() => changePin(db, env, { staff_id: 'dean', old_pin: '0000', new_pin: '9153' }, T0), refused(401, /wrong PIN/));
  await assert.rejects(() => changePin(db, env, { staff_id: 'dean', old_pin: '4821', new_pin: '1234' }, T0), /a straight run/);
  await assert.rejects(() => changePin(db, env, { staff_id: 'dean', old_pin: '4821', new_pin: '55' }, T0), /exactly four digits/);
});

// --------------------------------------------------------------- the Worker

test('through the Worker: a ledger write with no token is a 401, and a read is still open', async () => {
  const { db, env } = await world();
  const write = await worker.fetch(new Request('https://t.example/api/waste', { method: 'POST', body: '{}' }), env);
  assert.equal(write.status, 401);
  const read = await worker.fetch(new Request('https://t.example/api/health'), env);
  assert.equal(read.status, 200);
});

test('through the Worker: sign in, then change your PIN as the person the token names', async () => {
  const { db, env } = await world();
  const signedIn = await worker.fetch(new Request('https://t.example/api/login', {
    method: 'POST', body: JSON.stringify({ staff_id: 'dean', pin: '4821' }),
  }), env);
  assert.equal(signedIn.status, 200);
  const { token } = await signedIn.json();

  const changed = await worker.fetch(new Request('https://t.example/api/pin', {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ old_pin: '4821', new_pin: '9153' }),
  }), env);
  assert.equal(changed.status, 200, 'staff_id was not sent; the token supplied it');
  assert.ok((await login(db, env, { staff_id: 'dean', pin: '9153' })).token);
});

test('through the Worker: naming somebody else in the body is a 403', async () => {
  const { db, env } = await world();
  const token = await signIn(env, db, Date.now());
  const res = await worker.fetch(new Request('https://t.example/api/waste', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ staff_id: 'nikin' }),
  }), env);
  assert.equal(res.status, 403);
});

test('through the Worker: a lockout is a 429 with Retry-After', async () => {
  const { db, env } = await world();
  let res;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    res = await worker.fetch(new Request('https://t.example/api/login', {
      method: 'POST', body: JSON.stringify({ staff_id: 'dean', pin: '0000' }),
    }), env);
  }
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '600');
});

test('through the Worker: the public label routes need no token', async () => {
  const { env } = await world();
  const res = await worker.fetch(new Request('https://t.example/api/labels/render', { method: 'POST', body: '{}' }), env);
  assert.notEqual(res.status, 401);
  assert.notEqual(res.status, 403);
});
