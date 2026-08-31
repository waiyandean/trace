import { BadRequest } from '../http.js';

// The short-code pool (PLAN.md, open question "Lot identity and short
// codes", resolved 2026-08-28).
//
// A device at the goods-in door has to print a label before it can reach the
// server, so it cannot ask whether a code is free. Instead the server hands
// each device a block of codes it alone holds. Intake pops one locally; the
// device asks for more whenever it is online and running low.
//
// The alphabet is Crockford's base32 — the digits and letters with I, L, O
// and U removed — so nothing on a printed label can be misread as something
// else when a person types it in after a failed scan. Six characters over 32
// symbols is a billion codes; the pool is small and codes are never reused,
// so exhaustion is not a concern for this kitchen.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 6;

// Codes must look random rather than sequential. A sequential code invites
// reading a neighbouring box's label as this one's, and it leaks how much the
// kitchen received, which is nobody's business but the kitchen's.
export function mintCode(random = crypto) {
  const bytes = new Uint8Array(CODE_LENGTH);
  random.getRandomValues(bytes);
  let code = '';
  // 256 is not a multiple of 32, but it is 8 x 32, so masking the low five
  // bits keeps every symbol equally likely without any rejection sampling.
  for (const byte of bytes) code += ALPHABET[byte & 31];
  return code;
}

export function isCode(value) {
  if (typeof value !== 'string' || value.length !== CODE_LENGTH) return false;
  return [...value].every((character) => ALPHABET.includes(character));
}

async function requireDevice(db, deviceId) {
  if (!deviceId) throw new BadRequest('device_id is required');
  const device = await db
    .prepare('SELECT id, name, active FROM devices WHERE id = ?')
    .bind(deviceId)
    .first();
  if (!device) throw new BadRequest(`unknown device: ${deviceId}`);
  if (device.active !== 1) throw new BadRequest(`device is not active: ${deviceId}`);
  return device;
}

export async function poolFor(db, deviceId) {
  await requireDevice(db, deviceId);
  const { results } = await db
    .prepare('SELECT code, issued_at FROM short_codes WHERE device_id = ? AND lot_id IS NULL ORDER BY issued_at, code')
    .bind(deviceId)
    .all();
  return { device_id: deviceId, held: (results || []).length, codes: results || [] };
}

const MAX_ISSUE = 500;
const MAX_ATTEMPTS = 5;

// Tops a device's pool up to `want` unbound codes and returns the whole pool,
// so a device that has been offline can replace its store in one call.
//
// A collision with an existing code is possible and is simply skipped — the
// unique primary key is what guarantees a code belongs to one device, not the
// randomness — so this loops until it has issued enough.
export async function issueCodes(db, deviceId, want) {
  await requireDevice(db, deviceId);
  if (!Number.isInteger(want) || want < 1 || want > MAX_ISSUE) {
    throw new BadRequest(`want must be a whole number between 1 and ${MAX_ISSUE}`);
  }

  const before = await poolFor(db, deviceId);
  let shortfall = want - before.held;

  for (let attempt = 0; shortfall > 0 && attempt < MAX_ATTEMPTS; attempt += 1) {
    const statements = [];
    for (let i = 0; i < shortfall; i += 1) {
      statements.push(
        db
          .prepare('INSERT INTO short_codes (code, device_id) VALUES (?, ?) ON CONFLICT (code) DO NOTHING')
          .bind(mintCode(), deviceId),
      );
    }
    await db.batch(statements);
    const now = await poolFor(db, deviceId);
    shortfall = want - now.held;
  }

  const pool = await poolFor(db, deviceId);
  if (pool.held < want) {
    // Only reachable if the code space is genuinely crowded, which would mean
    // the six-character scheme has been outgrown. Say so plainly rather than
    // handing back a short pool that fails at the door later.
    throw new Error(`could not issue ${want} codes for ${deviceId}: the code space is exhausted`);
  }
  return pool;
}
