import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, withAuth, bearer, SESSION_KEY } from '../public/lib/auth.js';
import { makeStore, makeQueue, syncQueue } from '../public/lib/offline.js';

function storage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v) };
}

const login = (expires_at) => ({ token: 'tok', expires_at, staff: { id: 'dean', name: 'Dean' } });

test('a sign-in is a session only until it runs out', () => {
  let now = 1000;
  const session = makeSession(makeStore(storage()), () => now);
  assert.equal(session.current(), null, 'nothing before anybody signs in');
  session.save(login(5000));
  assert.equal(session.current().staff.name, 'Dean');
  now = 5000;
  assert.equal(session.current(), null, 'at the moment it expires it is gone');
});

test('clearing a session signs the device out', () => {
  const session = makeSession(makeStore(storage()), () => 1000);
  session.save(login(5000));
  session.clear();
  assert.equal(session.current(), null);
});

test('a session survives a reload, and a damaged one is no session at all', () => {
  const backing = storage();
  makeSession(makeStore(backing), () => 1000).save(login(5000));
  assert.equal(makeSession(makeStore(backing), () => 1000).current().token, 'tok');
  backing.setItem(SESSION_KEY, '{"token":"tok"}');
  assert.equal(makeSession(makeStore(backing), () => 1000).current(), null, 'no staff, no expiry');
  backing.setItem(SESSION_KEY, 'not json');
  assert.equal(makeSession(makeStore(backing), () => 1000).current(), null);
});

test('locked-down storage means signed out, not a crash', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const session = makeSession(makeStore(broken), () => 1000);
  assert.equal(session.current(), null);
  assert.equal(session.save(login(5000)), false, 'the caller is told it did not stick');
});

test('a token is attached unless the caller already chose one', () => {
  const plain = withAuth({ method: 'POST', headers: { 'content-type': 'application/json' } }, 'tok');
  assert.equal(plain.headers.authorization, 'Bearer tok');
  assert.equal(plain.headers['content-type'], 'application/json', 'other headers are kept');

  const own = withAuth({ headers: { Authorization: 'Bearer theirs' } }, 'mine');
  assert.equal(own.headers.Authorization, 'Bearer theirs', 'a queued record keeps its own token');
  assert.equal(own.headers.authorization, undefined);

  assert.deepEqual(withAuth({ method: 'GET' }, null), { method: 'GET' }, 'no session, nothing added');
});

test('a queued record keeps the token of the person who keyed it, and drops it once settled', async () => {
  const queue = makeQueue(makeStore(storage()));
  queue.add({ idempotency_key: 'a', lines: [] }, 'dean-token');
  queue.add({ idempotency_key: 'b', lines: [] }, 'nikin-token');
  queue.add({ idempotency_key: 'c', lines: [] });
  assert.deepEqual(queue.all().map((e) => e.token), ['dean-token', 'nikin-token', null]);

  const sentWith = [];
  await syncQueue(queue, async (payload, token) => {
    sentWith.push([payload.idempotency_key, token]);
    return payload.idempotency_key === 'b'
      ? { ok: false, status: 401, body: { error: 'sign in again: your sign-in has run out' } }
      : { ok: true, status: 201, body: {} };
  });

  assert.deepEqual(sentWith, [['a', 'dean-token'], ['b', 'nikin-token'], ['c', null]],
    'each goes out as whoever keyed it, not whoever is signed in now');
  assert.deepEqual(queue.all().map((e) => e.token), [null, null, null], 'none keeps a credential once settled');
  assert.deepEqual(queue.all().map((e) => e.status), ['sent', 'rejected', 'sent']);
  assert.match(queue.all()[1].error, /sign in again/, 'a refused record stays visible with the reason');
});

test('a still-pending record keeps its token so a retry can go out', async () => {
  const queue = makeQueue(makeStore(storage()));
  queue.add({ idempotency_key: 'a', lines: [] }, 'dean-token');
  await syncQueue(queue, async () => { throw new Error('offline'); });
  assert.equal(queue.pending()[0].token, 'dean-token');
});

test('bearer builds the header', () => {
  assert.deepEqual(bearer('x'), { authorization: 'Bearer x' });
});
