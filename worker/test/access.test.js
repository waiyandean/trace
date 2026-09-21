import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { verifyAccess, resetAccessCache, isLocalHost, isPublicApi } from '../src/access.js';
import { AuthError } from '../src/http.js';
import { fakeDb } from './fakeDb.js';

const TEAM = 'kitchen.cloudflareaccess.com';
const AUD = 'aud-tag-1234';
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const NOW = Date.parse('2026-09-21T12:00:00Z');

const b64u = (input) => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function keypair(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

async function token(key, claims = {}, header = {}) {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header }));
  const p = b64u(JSON.stringify({
    iss: `https://${TEAM}`, aud: [AUD], email: 'ramenhq97@gmail.com',
    iat: NOW / 1000 - 60, exp: NOW / 1000 + 3600, ...claims,
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

const asks = (jwt) => new Request('https://trace.deanops.uk/api/x', {
  headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {},
});

// A JWKS endpoint that counts how often it is asked.
function certs(...keys) {
  const calls = { n: 0, urls: [] };
  const fetchImpl = async (url) => {
    calls.n += 1;
    calls.urls.push(String(url));
    return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), { status: 200 });
  };
  return { calls, fetchImpl };
}

const refused = (status) => (err) => err instanceof AuthError && err.status === status;

test.beforeEach(() => resetAccessCache());

test('a token Access signed for this application is accepted, and names who', async () => {
  const key = await keypair('k1');
  const { fetchImpl, calls } = certs(key);
  const who = await verifyAccess(asks(await token(key)), env, { fetchImpl, now: NOW });
  assert.equal(who.email, 'ramenhq97@gmail.com');
  assert.deepEqual(calls.urls, [`https://${TEAM}/cdn-cgi/access/certs`]);
});

test('no token is refused', async () => {
  const { fetchImpl } = certs(await keypair('k1'));
  await assert.rejects(() => verifyAccess(asks(null), env, { fetchImpl, now: NOW }), refused(401));
});

test('a token signed by some other key is refused, even with a key id that exists', async () => {
  const real = await keypair('k1');
  const forger = await keypair('k1');
  const { fetchImpl } = certs(real);
  await assert.rejects(async () => verifyAccess(asks(await token(forger)), env, { fetchImpl, now: NOW }), refused(401));
});

test('a token for a different application is refused', async () => {
  const key = await keypair('k1');
  const { fetchImpl } = certs(key);
  await assert.rejects(
    async () => verifyAccess(asks(await token(key, { aud: ['some-other-app'] })), env, { fetchImpl, now: NOW }), refused(401));
});

test('a token from a different Access team is refused', async () => {
  const key = await keypair('k1');
  const { fetchImpl } = certs(key);
  await assert.rejects(
    async () => verifyAccess(asks(await token(key, { iss: 'https://someone-else.cloudflareaccess.com' })), env, { fetchImpl, now: NOW }),
    refused(401));
});

test('an expired token is refused, and one not yet valid is refused', async () => {
  const key = await keypair('k1');
  const { fetchImpl } = certs(key);
  await assert.rejects(
    async () => verifyAccess(asks(await token(key, { exp: NOW / 1000 - 300 })), env, { fetchImpl, now: NOW }), refused(401));
  await assert.rejects(
    async () => verifyAccess(asks(await token(key, { nbf: NOW / 1000 + 600 })), env, { fetchImpl, now: NOW }), refused(401));
});

test('an algorithm of none, or any other than RS256, is refused', async () => {
  const key = await keypair('k1');
  const { fetchImpl } = certs(key);
  const body = b64u(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW / 1000 + 3600 }));
  const none = `${b64u(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${body}.`;
  await assert.rejects(() => verifyAccess(asks(none), env, { fetchImpl, now: NOW }), refused(401));
  await assert.rejects(
    async () => verifyAccess(asks(await token(key, {}, { alg: 'HS256' })), env, { fetchImpl, now: NOW }), refused(401));
});

test('garbage in the header is refused rather than crashing', async () => {
  const { fetchImpl } = certs(await keypair('k1'));
  for (const junk of ['x', 'a.b', 'a.b.c', '...', '%%%.%%%.%%%']) {
    await assert.rejects(() => verifyAccess(asks(junk), env, { fetchImpl, now: NOW }), refused(401), junk);
  }
});

test('the keys are fetched once, not on every request', async () => {
  const key = await keypair('k1');
  const { fetchImpl, calls } = certs(key);
  for (let i = 0; i < 5; i += 1) await verifyAccess(asks(await token(key)), env, { fetchImpl, now: NOW + i });
  assert.equal(calls.n, 1);
});

test('a key rotation is picked up, and a stranger cannot make every request fetch', async () => {
  const old = await keypair('k1');
  const fresh = await keypair('k2');
  let served = [old];
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return new Response(JSON.stringify({ keys: served.map((k) => k.jwk) }), { status: 200 });
  };
  await verifyAccess(asks(await token(old)), env, { fetchImpl, now: NOW });
  assert.equal(n, 1);

  served = [old, fresh];
  // Inside the refetch window a token from an unknown key is just refused.
  await assert.rejects(async () => verifyAccess(asks(await token(fresh)), env, { fetchImpl, now: NOW + 5000 }), refused(401));
  assert.equal(n, 1, 'no refetch inside a minute');
  // After it, the rotation is found.
  const who = await verifyAccess(asks(await token(fresh)), env, { fetchImpl, now: NOW + 61000 });
  assert.equal(who.email, 'ramenhq97@gmail.com');
  assert.equal(n, 2);
});

test('if Access cannot be reached to check, the answer is no, not yes', async () => {
  const key = await keypair('k1');
  const down = async () => { throw new Error('network'); };
  await assert.rejects(async () => verifyAccess(asks(await token(key)), env, { fetchImpl: down, now: NOW }), refused(503));
  const broken = async () => new Response('nope', { status: 500 });
  await assert.rejects(async () => verifyAccess(asks(await token(key)), env, { fetchImpl: broken, now: NOW }), refused(503));
});

test('with the team or the audience unset, nothing is let through', async () => {
  const key = await keypair('k1');
  const { fetchImpl } = certs(key);
  const jwt = await token(key);
  for (const half of [{ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: '' }, { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: AUD }, {}]) {
    await assert.rejects(() => verifyAccess(asks(jwt), half, { fetchImpl, now: NOW }), refused(503));
  }
});

test('a team domain given with https:// or a trailing slash still matches', async () => {
  const key = await keypair('k1');
  const { fetchImpl } = certs(key);
  const who = await verifyAccess(asks(await token(key)), { ...env, ACCESS_TEAM_DOMAIN: `https://${TEAM}/` }, { fetchImpl, now: NOW });
  assert.equal(who.email, 'ramenhq97@gmail.com');
});

test('only localhost skips the check, and only the label routes are public', () => {
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('127.0.0.1'), true);
  for (const host of ['trace.deanops.uk', 'forms.deanops.uk', 'localhost.evil.com', 'evil-localhost']) {
    assert.equal(isLocalHost(host), false, host);
  }
  assert.equal(isPublicApi('/api/labels/render'), true);
  for (const path of ['/api/receive', '/api/ledger', '/api/labelsX', '/api/labels', '/api/health', '/api/whoami']) {
    assert.equal(isPublicApi(path), false, path);
  }
});

// ------------------------------------------------------------- the Worker

test('through the Worker: a read on a real hostname with no Access token is a 401', async () => {
  const res = await worker.fetch(new Request('https://trace.deanops.uk/api/catalog?action=locations'),
    { ...env, DB: fakeDb(() => []) });
  assert.equal(res.status, 401);
});

test('through the Worker: unconfigured, a real hostname refuses the API but not the label routes', async () => {
  const bare = { DB: fakeDb(() => []) };
  const api = await worker.fetch(new Request('https://forms.deanops.uk/api/catalog?action=locations'), bare);
  assert.equal(api.status, 503);
  const label = await worker.fetch(
    new Request('https://forms.deanops.uk/api/labels/render', { method: 'POST', body: '{}' }), bare);
  assert.notEqual(label.status, 503);
  assert.notEqual(label.status, 401);
});

test('through the Worker: a valid Access token gets a read through', async () => {
  const key = await keypair('k1');
  const { fetchImpl } = certs(key);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    // The Worker uses the real clock, so mint a token that is valid now.
    const live = await token(key, { iat: Date.now() / 1000 - 60, exp: Date.now() / 1000 + 3600 });
    const res = await worker.fetch(new Request('https://trace.deanops.uk/api/catalog?action=locations', {
      headers: { 'cf-access-jwt-assertion': live },
    }), { ...env, DB: fakeDb(() => [{ id: 'l1', name: 'Fridge', kind: 'chill', active: 1 }]) });
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
});
