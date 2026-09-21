import { AuthError } from './http.js';

// Cloudflare Access is the door in front of trace; this is the Worker
// checking, for itself, that the person really came through it.
//
// Access sits at the edge and, once an application is defined for
// trace.deanops.uk, nothing reaches the Worker without signing in. That is
// necessary and not enough: it is one dashboard setting, and if the
// application were ever deleted or its hostname edited, every read (the
// catalog, the ledger, every lot and every customer) would quietly become
// public and nothing here would notice. So every request that is not one of
// the deliberately public label routes must also carry the signed token
// Access adds, and it is verified here against Access's own published keys.
//
// Fails closed. With the team domain or the application's audience tag
// unset, the API refuses everything but the public label routes, which is
// what a half-configured deploy should do.
//
// Not applied to localhost, which is `wrangler dev` and the tests. A request
// for that hostname cannot arrive through Cloudflare's edge, which routes on
// the hostname it was sent, so there is no way to use it from outside.

const KEYS_TTL_MS = 60 * 60 * 1000;
// A token signed by a key not in the cache is either a rotation or somebody
// guessing. The first is answered by refetching, the second must not be able
// to turn every request into a fetch, so refetching is rate limited.
const REFETCH_MIN_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

const dec = new TextDecoder();

function unb64u(text) {
  const pad = '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad), (c) => c.charCodeAt(0));
}

let cache = { team: null, keys: new Map(), fetchedAt: 0 };

// Tests need each case to start with nothing cached.
export function resetAccessCache() {
  cache = { team: null, keys: new Map(), fetchedAt: 0 };
}

const refused = () => new AuthError(401, 'this has to be reached through Cloudflare Access');

async function keysFor(team, fetchImpl, now, { force }) {
  const fresh = cache.team === team && now - cache.fetchedAt < KEYS_TTL_MS;
  if (fresh && !force) return cache.keys;
  if (force && cache.team === team && now - cache.fetchedAt < REFETCH_MIN_MS) return cache.keys;

  let listing;
  try {
    const response = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
    if (!response.ok) throw new Error(`status ${response.status}`);
    listing = await response.json();
  } catch {
    throw new AuthError(503, 'could not check the Access sign-in just now, so nothing can be read');
  }

  const keys = new Map();
  for (const jwk of listing.keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    ));
  }
  cache = { team, keys, fetchedAt: now };
  return keys;
}

export const isLocalHost = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1';

// The label GUI is public by design. Everything else goes through Access.
export const isPublicApi = (path) => path.startsWith('/api/labels/');

// Returns who Access says is calling. Every failure is the same 401, so a
// bad token says nothing about which part of it was wrong.
export async function verifyAccess(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = env.ACCESS_AUD;
  if (!team || !aud) throw new AuthError(503, 'Access is not set up on this server, so nothing can be read');

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw refused();
  const parts = token.split('.');
  if (parts.length !== 3) throw refused();

  let header;
  let claims;
  let signature;
  try {
    header = JSON.parse(dec.decode(unb64u(parts[0])));
    claims = JSON.parse(dec.decode(unb64u(parts[1])));
    signature = unb64u(parts[2]);
  } catch {
    throw refused();
  }
  // Only the algorithm Access uses. Reading it from the token and obeying it
  // is how "alg: none" and key-confusion attacks work.
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw refused();

  let keys = await keysFor(team, fetchImpl, now, { force: false });
  let key = keys.get(header.kid);
  if (!key) {
    keys = await keysFor(team, fetchImpl, now, { force: true });
    key = keys.get(header.kid);
  }
  if (!key) throw refused();

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed))) throw refused();

  const nowS = Math.floor(now / 1000);
  const audiences = [].concat(claims.aud || []);
  if (claims.iss !== `https://${team}`
    || !audiences.includes(aud)
    || !Number.isFinite(claims.exp) || claims.exp + CLOCK_SKEW_S < nowS
    || (Number.isFinite(claims.nbf) && claims.nbf - CLOCK_SKEW_S > nowS)) {
    throw refused();
  }
  return { email: claims.email || null };
}
