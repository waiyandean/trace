import { AuthError, BadRequest } from './http.js';

// Who is recording (PLAN.md, open question 9).
//
// Before this, every form sent a `staff_id` from a dropdown and the server
// believed it. Now a person signs in with a four-digit PIN, the server checks
// it, and the id on every write comes from a signed token the server issued —
// the id in the request body is never the source of truth.
//
// Two secrets, deliberately separate, both held in the Worker's secrets and
// never in the database:
//
// - `PIN_PEPPER` keys the PIN hashes. There are only 10,000 four-digit PINs,
//   so a plain hash is cracked instantly; keyed with a secret a copy of the
//   database alone reveals nothing. Rotating it invalidates every PIN.
// - `AUTH_SECRET` signs the tokens. Rotating it signs everybody out and
//   nothing else, which is why it is not the same secret.
//
// Both must be set. With either missing every write is refused rather than
// waved through: an unconfigured server must not be an open one.

export const TOKEN_TTL_S = 12 * 3600;

// How long after a token expires a submission made while it was still valid
// is still accepted. Goods-in is taken out to the van and the yard and the
// wifi drops, so a delivery can sit in the device's queue for a while; it must
// not be lost because the shift's token lapsed in the meantime. Bounded so a
// stolen expired token cannot be used indefinitely.
export const QUEUE_GRACE_S = 7 * 86400;

const CLOCK_SKEW_S = 300;

export const MAX_ATTEMPTS = 5;
const LOCK_BASE_S = 600;
const LOCK_MAX_S = 86400;

const enc = new TextEncoder();

const b64u = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function unb64u(text) {
  const pad = '='.repeat((4 - (text.length % 4)) % 4);
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function requireSecrets(env) {
  for (const name of ['AUTH_SECRET', 'PIN_PEPPER']) {
    if (!env[name] || String(env[name]).length < 32) {
      throw new AuthError(503, 'sign-in is not set up on this server, so nothing can be recorded');
    }
  }
}

const hmacKey = (secret, usage) => crypto.subtle.importKey(
  'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage],
);

async function sign(secret, message) {
  const key = await hmacKey(secret, 'sign');
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// crypto.subtle.verify compares in constant time, which a hand-written
// comparison of two hashes would not.
async function verifySignature(secret, message, signature) {
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, signature, enc.encode(message));
}

// ---------------------------------------------------------------------- PINs

// Four digits, and not the ones a person picks when they are not thinking:
// repeats and straight runs. Applied to a PIN somebody chooses or one this
// system generates. It is not applied when an administrator sets a PIN, so a
// code somebody already uses elsewhere can be reused, at the cost of being
// told it is weak (see `weakness`).
export function weakness(pin) {
  if (/^(\d)\1{3}$/.test(pin)) return 'all the same digit';
  const d = [...pin].map(Number);
  const step = d[1] - d[0];
  if (Math.abs(step) === 1 && d.every((n, i) => i === 0 || n - d[i - 1] === step)) {
    return 'a straight run of digits';
  }
  return null;
}

function requirePinShape(pin) {
  if (!/^\d{4}$/.test(String(pin ?? ''))) throw new BadRequest('a PIN is exactly four digits');
}

export async function makePinRow(env, pin) {
  requirePinShape(pin);
  const salt = b64u(crypto.getRandomValues(new Uint8Array(12)));
  return { salt, pin_hash: b64u(await sign(env.PIN_PEPPER, `pin:${salt}:${pin}`)) };
}

export async function pinMatches(env, row, pin) {
  return verifySignature(env.PIN_PEPPER, `pin:${row.salt}:${pin}`, unb64u(row.pin_hash));
}

// The comparison `pinCollision` and `identifyByPin` both do, pulled out so
// `scripts/set-pin.mjs` — which reaches the database through the `wrangler`
// CLI, not this file's `db.prepare()` calls — can run the same check itself
// on rows it fetched its own way, rather than a second copy of the logic.
export async function findPinCollision(env, rows, pin, excludeStaffId = null) {
  for (const row of rows) {
    if (row.id === excludeStaffId) continue;
    if (await pinMatches(env, row, pin)) return { id: row.id, name: row.name };
  }
  return null;
}

const minutes = (seconds) => Math.max(1, Math.ceil(seconds / 60));

// The lockout bookkeeping, shared by a named person's own row (`staff_pins`)
// and the single shared row for a blind guess that matched nobody
// (`identify_lockout`). Both tables have the same three columns for exactly
// this reason.
function lockoutStore(table, key, whoFailed) {
  return {
    async current(db) {
      return db.prepare(`SELECT failed_count, lock_level, locked_until FROM ${table} WHERE ${key.column} = ?`)
        .bind(key.value).first();
    },
    async isLocked(db, nowMs) {
      const row = await this.current(db);
      if (!row?.locked_until) return null;
      const left = (Date.parse(row.locked_until) - nowMs) / 1000;
      return left > 0 ? left : null;
    },
    async clear(db) {
      await db.prepare(`UPDATE ${table} SET failed_count = 0, lock_level = 0, locked_until = NULL WHERE ${key.column} = ?`)
        .bind(key.value).run();
    },
    // Returns how many seconds the failure just locked things out for, or
    // null if there is still at least one try left.
    async fail(db, nowMs) {
      // Incremented in the statement, not read and written back, so a burst
      // of guesses cannot each start from the same count.
      await db.prepare(`UPDATE ${table} SET failed_count = failed_count + 1 WHERE ${key.column} = ?`)
        .bind(key.value).run();
      const row = await this.current(db);
      if (row.failed_count < MAX_ATTEMPTS) return { locked: null, triesLeft: MAX_ATTEMPTS - row.failed_count };
      const level = row.lock_level + 1;
      const seconds = Math.min(LOCK_BASE_S * 2 ** (level - 1), LOCK_MAX_S);
      await db.prepare(`UPDATE ${table} SET failed_count = 0, lock_level = ?, locked_until = ? WHERE ${key.column} = ?`)
        .bind(level, new Date(nowMs + seconds * 1000).toISOString(), key.value).run();
      return { locked: seconds, triesLeft: 0 };
    },
    whoFailed,
  };
}

const staffLockout = (staffId) => lockoutStore('staff_pins', { column: 'staff_id', value: staffId });
const identifyLockout = () => lockoutStore('identify_lockout', { column: 'id', value: 'identify' });

// Checks a PIN against one named person and keeps that person's lockout
// books. A person who is locked out is refused before the PIN is even looked
// at, so guessing during a lockout neither succeeds nor learns anything, and
// does not extend it.
async function checkPin(db, env, staff, pin, nowMs) {
  requirePinShape(pin);
  const lockout = staffLockout(staff.id);
  const row = await db
    .prepare('SELECT pin_hash, salt FROM staff_pins WHERE staff_id = ?')
    .bind(staff.id).first();
  if (!row) throw new AuthError(401, `no PIN is set for ${staff.name}; ask whoever runs trace to set one`);

  const lockedFor = await lockout.isLocked(db, nowMs);
  if (lockedFor !== null) {
    throw new AuthError(429, `too many wrong PINs for ${staff.name}; try again in ${minutes(lockedFor)} min`,
      { retryAfter: Math.ceil(lockedFor) });
  }

  if (await pinMatches(env, row, pin)) {
    await lockout.clear(db);
    return;
  }

  const result = await lockout.fail(db, nowMs);
  if (result.locked !== null) {
    throw new AuthError(429, `too many wrong PINs for ${staff.name}; try again in ${minutes(result.locked)} min`,
      { retryAfter: result.locked });
  }
  throw new AuthError(401,
    `wrong PIN for ${staff.name}; ${result.triesLeft} ${result.triesLeft === 1 ? 'try' : 'tries'} left`);
}

// Whether `pin` is already somebody else's, checked by trying it against
// every other active person's stored hash rather than by a database lookup —
// the hash is salted per row precisely so it cannot be looked up directly.
// This is what typing a PIN alone (`identify`, below) depends on: it only
// works while PINs are unique, so nothing may set one that collides.
export async function pinCollision(db, env, pin, excludeStaffId = null) {
  const { results } = await db
    .prepare('SELECT s.id, s.name, p.pin_hash, p.salt FROM staff_pins p JOIN staff s ON s.id = p.staff_id WHERE s.active = 1')
    .all();
  return findPinCollision(env, results || [], pin, excludeStaffId);
}

// Who `pin` belongs to, with nobody chosen first. Tries it against every
// active, currently-unlocked person's PIN; a locked person's row is skipped
// entirely, so a correct guess against a locked account neither signs
// them in nor reveals that it was close. Every candidate is still checked
// even after a match, so how many people happen to be enrolled does not
// change how long this takes to answer.
//
// Blind guessing has no one person to charge a wrong attempt to, so it is
// charged to the shared `identify_lockout` row instead (PLAN.md, open
// question 9) — a lock on guessing, never a second lock on any one account.
// Picking a name and entering that person's PIN goes through `checkPin`
// above and is never affected by this.
async function identifyByPin(db, env, pin, nowMs) {
  requirePinShape(pin);
  const lockout = identifyLockout();
  const lockedFor = await lockout.isLocked(db, nowMs);
  if (lockedFor !== null) {
    throw new AuthError(429, `too many wrong PINs; try again in ${minutes(lockedFor)} min, or choose your name`,
      { retryAfter: Math.ceil(lockedFor) });
  }

  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, p.pin_hash, p.salt FROM staff_pins p
         JOIN staff s ON s.id = p.staff_id
        WHERE s.active = 1 AND (p.locked_until IS NULL OR p.locked_until <= ?)`,
    )
    .bind(new Date(nowMs).toISOString())
    .all();

  let match = null;
  let ambiguous = false;
  for (const row of results || []) {
    if (await pinMatches(env, row, pin)) {
      if (match) ambiguous = true;
      else match = row;
    }
  }

  // Two people sharing a PIN should be impossible (`pinCollision` refuses
  // setting one), but if it ever happened silently picking a winner would
  // attribute somebody's record to the wrong person, so this refuses instead
  // of guessing and says to use the name picker, which asks nothing of the
  // PIN's uniqueness.
  if (!match || ambiguous) {
    const result = await lockout.fail(db, nowMs);
    if (result.locked !== null) {
      throw new AuthError(429, `too many wrong PINs; try again in ${minutes(result.locked)} min, or choose your name`,
        { retryAfter: result.locked });
    }
    throw new AuthError(401, "PIN not recognised; choose your name if you're sure it's right");
  }

  await lockout.clear(db);
  return match;
}

async function activeStaff(db, id) {
  const staff = await db.prepare('SELECT id, name, active FROM staff WHERE id = ?').bind(id).first();
  if (!staff) throw new BadRequest(`unknown staff ${JSON.stringify(id)}`);
  if (!staff.active) throw new AuthError(403, `${staff.name} is no longer active`);
  return staff;
}

// -------------------------------------------------------------------- tokens

async function issueToken(env, staffId, nowMs) {
  const iat = Math.floor(nowMs / 1000);
  const body = b64u(enc.encode(JSON.stringify({ sub: staffId, iat, exp: iat + TOKEN_TTL_S })));
  return { token: `${body}.${b64u(await sign(env.AUTH_SECRET, `token:${body}`))}`, expires_at: (iat + TOKEN_TTL_S) * 1000 };
}

// Signature and shape only. Whether it is still valid is a separate question
// because it depends on when the thing being recorded happened.
async function readToken(env, token) {
  const [body, signature] = String(token).split('.');
  let claims;
  try {
    if (!body || !signature || !(await verifySignature(env.AUTH_SECRET, `token:${body}`, unb64u(signature)))) {
      throw new Error('bad signature');
    }
    claims = JSON.parse(new TextDecoder().decode(unb64u(body)));
  } catch {
    throw new AuthError(401, 'sign in again: this sign-in is not valid');
  }
  if (!claims.sub || !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) {
    throw new AuthError(401, 'sign in again: this sign-in is not valid');
  }
  return claims;
}

const bearer = (request) => (request.headers.get('authorization') || '').match(/^Bearer (.+)$/i)?.[1];

// ------------------------------------------------------------------ handlers

// With a `staff_id`, this is the original flow: a name was chosen, so the
// PIN is checked against that one person and locks only them out. With none,
// the PIN alone has to say who it is (`identifyByPin`), which is the primary
// way in now and falls back to naming yourself on request only when it
// cannot find a match — see `lib/signin.js`.
export async function login(db, env, body, nowMs = Date.now()) {
  requireSecrets(env);
  let staff;
  if (body?.staff_id) {
    staff = await activeStaff(db, body.staff_id);
    await checkPin(db, env, staff, body?.pin, nowMs);
  } else {
    staff = await identifyByPin(db, env, body?.pin, nowMs);
  }
  const { token, expires_at } = await issueToken(env, staff.id, nowMs);
  return { token, expires_at, staff: { id: staff.id, name: staff.name } };
}

// Every write goes through here. It returns nothing: it sets `body.staff_id`
// from the token, which is what makes the rest of the ledger code, which
// already reads `payload.staff_id`, safe without being touched.
//
// A token is judged by when the thing was done, not when it arrived: a
// delivery keyed at 06:10 and sent at 09:40 from a queue was made with a token
// that was valid, and is accepted. What is refused is a token used before it
// was issued, after it expired, or long after (`QUEUE_GRACE_S`).
export async function authenticate(db, env, request, readBody, nowMs = Date.now()) {
  requireSecrets(env);
  const token = bearer(request);
  if (!token) throw new AuthError(401, 'sign in first');
  const claims = await readToken(env, token);

  const body = await readBody();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('the body must be a JSON object');

  // A time in the future is not believed: it is treated as now, so it cannot
  // be used to stretch a token's life.
  const said = Date.parse(body.occurred_at);
  const madeAt = Number.isFinite(said) ? Math.min(said, nowMs) : nowMs;
  if (madeAt < (claims.iat - CLOCK_SKEW_S) * 1000) throw new AuthError(401, 'sign in again: this was recorded before you signed in');
  if (madeAt > claims.exp * 1000) throw new AuthError(401, 'sign in again: your sign-in has run out');
  if (nowMs > (claims.exp + QUEUE_GRACE_S) * 1000) throw new AuthError(401, 'sign in again: this sign-in is too old');

  const staff = await activeStaff(db, claims.sub);
  if (body.staff_id !== undefined && body.staff_id !== null && body.staff_id !== staff.id) {
    throw new AuthError(403, `you are signed in as ${staff.name}, but this says it was somebody else`);
  }
  body.staff_id = staff.id;
  return staff;
}

export async function whoami(db, env, request, nowMs = Date.now()) {
  requireSecrets(env);
  const token = bearer(request);
  if (!token) throw new AuthError(401, 'sign in first');
  const claims = await readToken(env, token);
  if (nowMs > claims.exp * 1000) throw new AuthError(401, 'sign in again: your sign-in has run out');
  const staff = await activeStaff(db, claims.sub);
  return { staff: { id: staff.id, name: staff.name }, expires_at: claims.exp * 1000 };
}

// Changing your own PIN takes the old one, and the new one is held to the
// weakness rule that an administrator setting one is not. The person is the
// one the token names, never one named in the body.
export async function changePin(db, env, body, nowMs = Date.now()) {
  requireSecrets(env);
  const staff = await activeStaff(db, body.staff_id);
  requirePinShape(body.new_pin);
  const weak = weakness(body.new_pin);
  if (weak) throw new BadRequest(`that PIN is ${weak}; pick one that is harder to guess`);
  await checkPin(db, env, staff, body.old_pin, nowMs);
  // Typing a PIN alone has to find one person, so nobody may hold another
  // active person's PIN — checked here, after the old PIN is confirmed
  // correct, so this cannot be used to probe whether a guessed PIN belongs to
  // somebody else.
  const collision = await pinCollision(db, env, body.new_pin, staff.id);
  if (collision) throw new BadRequest(`that PIN is already somebody else's; pick a different one`);
  const row = await makePinRow(env, body.new_pin);
  await db.prepare(
    `UPDATE staff_pins SET pin_hash = ?, salt = ?, set_at = datetime('now'),
                           failed_count = 0, lock_level = 0, locked_until = NULL
      WHERE staff_id = ?`,
  ).bind(row.pin_hash, row.salt, staff.id).run();
  return { ok: true };
}
