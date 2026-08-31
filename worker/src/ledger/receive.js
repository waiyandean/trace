import { BadRequest } from '../http.js';
import { toBaseUnit } from './units.js';
import { isCode } from './codes.js';

// Goods intake. One submission books one delivery: it opens a lot per
// delivery line and writes the RECEIVE movement that puts that lot's quantity
// into a storage area.
//
// The structural change P1 makes is that recording the delivery and printing
// its labels become one act rather than two disconnected ones. That is why
// the short code arrives in the request: the device has already popped it
// from its pool and printed it, and this endpoint binds it to the lot the
// same submission creates. Nothing is joined by inference afterwards.
//
// Everything here refuses rather than assumes. An unknown item, a unit with
// no recorded conversion, a storage area that does not exist — each is a 400
// naming what is missing. A guess at intake is a wrong balance for the life
// of the lot and a wrong answer at the one moment this system exists for.

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

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function requireUlid(value, field) {
  if (typeof value !== 'string' || !ULID.test(value)) {
    throw new BadRequest(`${field} must be a ULID minted on the device, got ${JSON.stringify(value)}`);
  }
  return value;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireTimestamp(value, field) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequest(`${field} must be an ISO 8601 timestamp with a zone, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireDate(value, field) {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequest(`${field} must be a date as YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return value;
}

// The shelf-life fallback, applied only where the supplier printed no date
// (PLAN.md open question 5). Whole days from the day the delivery arrived.
export function deriveUseBy(occurredAt, shelfLifeDays) {
  const arrived = new Date(occurredAt);
  const useBy = new Date(Date.UTC(arrived.getUTCFullYear(), arrived.getUTCMonth(), arrived.getUTCDate()));
  useBy.setUTCDate(useBy.getUTCDate() + shelfLifeDays);
  return useBy.toISOString().slice(0, 10);
}

async function lookup(db, sql, id) {
  return db.prepare(sql).bind(id).first();
}

// Reads back what one submission wrote. Used both for a fresh submission and
// for the replay of one already accepted, so a device gets the same answer
// either way and never has to treat a duplicate differently.
export async function eventResult(db, eventId) {
  const [lots, movements] = await Promise.all([
    db
      .prepare(
        `SELECT l.id, l.item_id, i.name AS item_name, i.base_unit, l.short_code, l.batch_code,
                l.supplier_id, l.supplier_lot, l.supplier_invoice, l.originated_at,
                l.use_by, l.use_by_source, l.status
           FROM lots l JOIN items i ON i.id = l.item_id
          WHERE l.event_id = ? ORDER BY i.name`,
      )
      .bind(eventId)
      .all(),
    db
      .prepare(
        `SELECT id, lot_id, type, quantity, entered_quantity, entered_unit, to_location_id, occurred_at
           FROM movements WHERE event_id = ? ORDER BY id`,
      )
      .bind(eventId)
      .all(),
  ]);
  return { event_id: eventId, lots: lots.results || [], movements: movements.results || [] };
}

// Validates one delivery line against the catalog and works out everything
// the ledger needs. Reads only; the writing happens once every line has come
// through this, so a submission is accepted whole or not at all.
async function prepareLine(db, line, index, envelope) {
  const where = `lines[${index}]`;
  const lotId = requireUlid(line.lot_id, `${where}.lot_id`);

  // A lot id is minted once, on the device, for one physical delivery line.
  // Seeing it again under a new idempotency key means a queued submission was
  // edited and resent rather than retried, and accepting it would book the
  // same cases twice. The earlier submission is named so the difference can
  // be looked at rather than guessed.
  const already = await lookup(db, 'SELECT id, event_id FROM lots WHERE id = ?', lotId);
  if (already) {
    throw new BadRequest(
      `${where}: lot ${lotId} already exists, booked by event ${already.event_id}. ` +
        'Retry the original submission with its own idempotency key, or mint a new lot.',
    );
  }

  const item = await lookup(db, 'SELECT id, name, base_unit, shelf_life_days, active FROM items WHERE id = ?', line.item_id);
  if (!item) throw new BadRequest(`${where}: unknown item ${JSON.stringify(line.item_id)}`);
  if (item.active !== 1) throw new BadRequest(`${where}: ${item.name} is not an active item`);

  const location = await lookup(db, 'SELECT id, name, active FROM locations WHERE id = ?', line.location_id);
  if (!location) throw new BadRequest(`${where}: unknown location ${JSON.stringify(line.location_id)}`);
  if (location.active !== 1) throw new BadRequest(`${where}: ${location.name} is not an active location`);

  if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0) {
    throw new BadRequest(`${where}.quantity must be a positive number, got ${JSON.stringify(line.quantity)}`);
  }
  const unit = line.unit || item.base_unit;
  if (typeof unit !== 'string') throw new BadRequest(`${where}.unit must be a unit name`);
  const converted = await toBaseUnit(db, item, line.quantity, unit);

  // A date on the box wins. Where there is none the item's shelf life fills
  // in, and the lot records which of the two it was.
  let useBy = null;
  let useBySource = null;
  if (line.use_by !== undefined && line.use_by !== null) {
    useBy = requireDate(line.use_by, `${where}.use_by`);
    useBySource = line.use_by_source || 'supplier_printed';
    if (!['supplier_printed', 'shelf_life_rule'].includes(useBySource)) {
      throw new BadRequest(`${where}.use_by_source must be supplier_printed or shelf_life_rule`);
    }
  } else {
    useBy = deriveUseBy(envelope.occurred_at, item.shelf_life_days);
    useBySource = 'shelf_life_rule';
  }

  // The code was popped from this device's pool and is already on a printed
  // label, so it must be one this device holds and must not be bound to
  // another lot. Absent is allowed: a dry pool delays the label, not the lot.
  let shortCode = null;
  if (line.short_code !== undefined && line.short_code !== null) {
    if (!isCode(line.short_code)) {
      throw new BadRequest(`${where}.short_code is not a valid code: ${JSON.stringify(line.short_code)}`);
    }
    const held = await lookup(db, 'SELECT code, device_id, lot_id FROM short_codes WHERE code = ?', line.short_code);
    if (!held) throw new BadRequest(`${where}: short code ${line.short_code} was never issued`);
    if (held.device_id !== envelope.device_id) {
      throw new BadRequest(`${where}: short code ${line.short_code} belongs to another device`);
    }
    if (held.lot_id && held.lot_id !== lotId) {
      throw new BadRequest(`${where}: short code ${line.short_code} is already bound to lot ${held.lot_id}`);
    }
    shortCode = held.code;
  }

  return {
    lotId,
    item,
    shortCode,
    batchCode: line.batch_code ?? null,
    supplierLot: line.supplier_lot ?? null,
    useBy,
    useBySource,
    note: line.note ?? null,
    locationId: location.id,
    quantity: converted.quantity,
    enteredQuantity: line.quantity,
    enteredUnit: unit,
    movementId: `${lotId}-RECEIVE`,
  };
}

async function validateEnvelope(db, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BadRequest('the body must be a JSON object');
  }
  const eventId = requireUlid(payload.event_id, 'event_id');
  if (typeof payload.idempotency_key !== 'string' || payload.idempotency_key.length < 8) {
    throw new BadRequest('idempotency_key must be a string of at least 8 characters, minted with the submission');
  }
  const occurredAt = requireTimestamp(payload.occurred_at, 'occurred_at');

  const staff = await lookup(db, 'SELECT id, name, active FROM staff WHERE id = ?', payload.staff_id);
  if (!staff) throw new BadRequest(`unknown staff ${JSON.stringify(payload.staff_id)}`);
  if (staff.active !== 1) throw new BadRequest(`${staff.name} is not active`);

  const device = await lookup(db, 'SELECT id, active FROM devices WHERE id = ?', payload.device_id);
  if (!device) throw new BadRequest(`unknown device ${JSON.stringify(payload.device_id)}`);
  if (device.active !== 1) throw new BadRequest(`device is not active: ${device.id}`);

  const supplier = await lookup(db, 'SELECT id, name, active FROM suppliers WHERE id = ?', payload.supplier_id);
  if (!supplier) throw new BadRequest(`unknown supplier ${JSON.stringify(payload.supplier_id)}`);
  if (supplier.active !== 1) throw new BadRequest(`${supplier.name} is not an active supplier`);

  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new BadRequest('lines must be a non-empty array: a delivery with no lines is not a delivery');
  }

  return {
    event_id: eventId,
    idempotency_key: payload.idempotency_key,
    occurred_at: occurredAt,
    staff_id: staff.id,
    device_id: device.id,
    supplier_id: supplier.id,
    invoice: payload.invoice ?? null,
  };
}

export async function receive(db, payload) {
  const envelope = await validateEnvelope(db, payload);
  const hash = await payloadHash(payload);

  // A submission that has already been accepted is answered with what it
  // wrote, not written again. This is the whole reason the key exists: the
  // device retries a queued submission until it hears back, and it must be
  // able to retry safely.
  const existing = await db
    .prepare('SELECT id, payload_hash FROM events WHERE idempotency_key = ?')
    .bind(envelope.idempotency_key)
    .first();
  if (existing) {
    if (existing.payload_hash !== hash) {
      throw new BadRequest(
        `idempotency key ${envelope.idempotency_key} was already used for a different submission. ` +
          'Keys are minted per submission and must never be reused.',
      );
    }
    return { duplicate: true, ...(await eventResult(db, existing.id)) };
  }

  const lines = [];
  for (const [index, line] of payload.lines.entries()) {
    lines.push(await prepareLine(db, line, index, envelope));
  }

  const codes = lines.map((line) => line.shortCode).filter(Boolean);
  if (new Set(codes).size !== codes.length) {
    throw new BadRequest('two lines in this submission carry the same short code');
  }
  const lotIds = lines.map((line) => line.lotId);
  if (new Set(lotIds).size !== lotIds.length) {
    throw new BadRequest('two lines in this submission carry the same lot id');
  }

  const statements = [
    db
      .prepare(
        `INSERT INTO events (id, kind, idempotency_key, payload_hash, staff_id, device_id, occurred_at, payload)
         VALUES (?, 'receive', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        envelope.event_id,
        envelope.idempotency_key,
        hash,
        envelope.staff_id,
        envelope.device_id,
        envelope.occurred_at,
        JSON.stringify(payload),
      ),
  ];

  for (const line of lines) {
    statements.push(
      db
        .prepare(
          `INSERT INTO lots (id, item_id, short_code, batch_code, origin, supplier_id, supplier_lot,
                             supplier_invoice, originated_at, use_by, use_by_source, event_id, note)
           VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          line.lotId,
          line.item.id,
          line.shortCode,
          line.batchCode,
          envelope.supplier_id,
          line.supplierLot,
          envelope.invoice,
          envelope.occurred_at,
          line.useBy,
          line.useBySource,
          envelope.event_id,
          line.note,
        ),
    );

    // The code is bound only now, from the same transaction that creates the
    // lot, so a code can never be recorded as spent against a lot that was
    // never written.
    if (line.shortCode) {
      statements.push(
        db
          .prepare("UPDATE short_codes SET lot_id = ?, bound_at = datetime('now') WHERE code = ? AND lot_id IS NULL")
          .bind(line.lotId, line.shortCode),
      );
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO movements (id, lot_id, type, quantity, entered_quantity, entered_unit,
                                  to_location_id, occurred_at, staff_id, event_id)
           VALUES (?, ?, 'RECEIVE', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          line.movementId,
          line.lotId,
          line.quantity,
          line.enteredQuantity,
          line.enteredUnit,
          line.locationId,
          envelope.occurred_at,
          envelope.staff_id,
          envelope.event_id,
        ),
    );
  }

  try {
    await db.batch(statements);
  } catch (err) {
    // Two copies of one submission can arrive at once from a device that
    // retried while the first was still in flight. The unique key is what
    // decides; the loser reads back what the winner wrote.
    const raced = await db
      .prepare('SELECT id, payload_hash FROM events WHERE idempotency_key = ?')
      .bind(envelope.idempotency_key)
      .first();
    if (raced && raced.payload_hash === hash) {
      return { duplicate: true, ...(await eventResult(db, raced.id)) };
    }
    throw err;
  }

  return { duplicate: false, ...(await eventResult(db, envelope.event_id)) };
}
