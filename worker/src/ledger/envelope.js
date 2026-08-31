import { BadRequest } from '../http.js';

// The parts every submission has in common, whatever it is recording.
//
// Goods intake had all of this to itself while it was the only form. Moving
// stock, throwing it away and holding it need exactly the same envelope — an
// id minted on the device, an idempotency key, two clocks and a named person
// — so it lives here rather than being copied and drifting.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function requireUlid(value, field) {
  if (typeof value !== 'string' || !ULID.test(value)) {
    throw new BadRequest(`${field} must be a ULID minted on the device, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function requireTimestamp(value, field) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequest(`${field} must be an ISO 8601 timestamp with a zone, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function requireDate(value, field) {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequest(`${field} must be a date as YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function requireQuantity(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BadRequest(`${field} must be a positive number, got ${JSON.stringify(value)}`);
  }
  return value;
}

// Key order must not change a payload's identity, so the fingerprint is taken
// over a canonical form rather than the bytes as they arrived.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export async function payloadHash(payload) {
  const bytes = new TextEncoder().encode(canonical(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function lookupRow(db, sql, id) {
  return db.prepare(sql).bind(id).first();
}

// The staff, device and clocks every submission carries. Returns the values
// as the ledger will store them, so a caller never reaches back into the raw
// payload for something already checked.
export async function validateEnvelope(db, payload, { requireDevice = true } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BadRequest('the body must be a JSON object');
  }
  const eventId = requireUlid(payload.event_id, 'event_id');
  if (typeof payload.idempotency_key !== 'string' || payload.idempotency_key.length < 8) {
    throw new BadRequest('idempotency_key must be a string of at least 8 characters, minted with the submission');
  }
  const occurredAt = requireTimestamp(payload.occurred_at, 'occurred_at');

  const staff = await lookupRow(db, 'SELECT id, name, active FROM staff WHERE id = ?', payload.staff_id);
  if (!staff) throw new BadRequest(`unknown staff ${JSON.stringify(payload.staff_id)}`);
  if (staff.active !== 1) throw new BadRequest(`${staff.name} is not active`);

  let deviceId = null;
  if (requireDevice) {
    const device = await lookupRow(db, 'SELECT id, active FROM devices WHERE id = ?', payload.device_id);
    if (!device) throw new BadRequest(`unknown device ${JSON.stringify(payload.device_id)}`);
    if (device.active !== 1) throw new BadRequest(`device is not active: ${device.id}`);
    deviceId = device.id;
  }

  return { event_id: eventId, idempotency_key: payload.idempotency_key, occurred_at: occurredAt, staff_id: staff.id, device_id: deviceId };
}

// A submission already accepted is answered with what it wrote, not written
// again. A key reused for different content is a bug or a reused key, and is
// refused rather than silently ignored.
export async function alreadyAccepted(db, idempotencyKey, hash) {
  const existing = await db
    .prepare('SELECT id, payload_hash FROM events WHERE idempotency_key = ?')
    .bind(idempotencyKey)
    .first();
  if (!existing) return null;
  if (existing.payload_hash !== hash) {
    throw new BadRequest(
      `idempotency key ${idempotencyKey} was already used for a different submission. ` +
        'Keys are minted per submission and must never be reused.',
    );
  }
  return existing;
}

export function eventRow(db, envelope, kind, hash, payload) {
  return db
    .prepare(
      `INSERT INTO events (id, kind, idempotency_key, payload_hash, staff_id, device_id, occurred_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      envelope.event_id,
      kind,
      envelope.idempotency_key,
      hash,
      envelope.staff_id,
      envelope.device_id,
      envelope.occurred_at,
      JSON.stringify(payload),
    );
}
