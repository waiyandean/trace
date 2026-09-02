import { BadRequest } from '../http.js';
import {
  validateEnvelope, requireUlid, requireQuantity, payloadHash, alreadyAccepted, eventRow, lookupRow,
} from './envelope.js';
import { toBaseUnit } from './units.js';
import { isCode } from './codes.js';
import { balanceAt, holdsOn } from './stock.js';
import { checkpointsFor, planReadings, readingRow } from './checkpoints.js';

// Starting a batch: what went into it.
//
// This records the ingredients as they go in, and nothing that has not
// happened yet (Dean, 2026-09-02). The cooking temperature is taken while it
// cooks, the cooling temperatures hours later, and how much it made is not
// known until it is packed — so none of them are asked for here. A form that
// asked would be asking somebody to type a number before it existed.
//
// So the batch consumes from the identified lots and opens the product's lot
// holding nothing. That is not a gap in the record, it is the record: during
// cooking the ingredients have genuinely gone and the product does not yet
// exist. The `PRODUCE` movement is written when it is packed out.
//
// The `CONSUME` rows carry the new lot as their counterpart, which is the
// genealogy edge: one step back from a product is the lots its consuming
// movements name.
//
// Two things about it are decisions rather than mechanics.
//
// **Lot selection is per line, and a line may name several lots.** Half a
// batch of broth from one case of carcasses and half from another is the
// ordinary case, not an edge case, so a line takes a list of allocations
// rather than a single lot.
//
// **An ingredient with no identified lot does not stop the batch.** The
// kitchen's answer (Dean, 2026-08-31) is that the batch proceeds and the gap
// is recorded. A blocked batch with a pot on the heat gets worked around, and
// the way around it is a plausible wrong lot — which is worse than an honest
// hole, because it cannot be seen afterwards.

async function productAndRecipe(db, itemId) {
  const item = await lookupRow(
    db,
    "SELECT id, name, base_unit, kind, active FROM items WHERE id = ?",
    itemId,
  );
  if (!item) throw new BadRequest(`unknown product ${JSON.stringify(itemId)}`);
  if (item.kind !== 'product') throw new BadRequest(`${item.name} is not a product`);
  if (item.active !== 1) throw new BadRequest(`${item.name} is not an active product`);

  const recipe = await lookupRow(
    db,
    'SELECT id, shelf_life_days FROM recipes WHERE item_id = ? AND active = 1',
    itemId,
  );
  return { item, recipe };
}

// The use-by is derived once, from the recipe's stated shelf life, rather than
// typed per batch (PLAN.md, open question "Shelf-life ownership"). A batch of
// a product with no recipe shelf life gets no use-by at all rather than a
// guessed one — and the lot records which of the two happened.
export function deriveUseBy(producedAt, shelfLifeDays) {
  const made = new Date(producedAt);
  const useBy = new Date(Date.UTC(made.getUTCFullYear(), made.getUTCMonth(), made.getUTCDate()));
  useBy.setUTCDate(useBy.getUTCDate() + shelfLifeDays);
  return useBy.toISOString().slice(0, 10);
}

async function prepareAllocation(db, allocation, where, envelope) {
  const lot = await lookupRow(
    db,
    `SELECT l.id, l.status, l.item_id, i.name AS item_name, i.base_unit
       FROM lots l JOIN items i ON i.id = l.item_id WHERE l.id = ?`,
    allocation.lot_id,
  );
  if (!lot) throw new BadRequest(`${where}: unknown lot ${JSON.stringify(allocation.lot_id)}`);

  const location = await lookupRow(
    db,
    'SELECT id, name, active FROM locations WHERE id = ?',
    allocation.location_id,
  );
  if (!location) throw new BadRequest(`${where}: unknown location ${JSON.stringify(allocation.location_id)}`);

  const holds = await holdsOn(db, lot.id);
  if (holds.total) {
    throw new BadRequest(`${where}: that lot of ${lot.item_name} is held and cannot be used in a batch`);
  }

  const quantity = requireQuantity(allocation.quantity, `${where}.quantity`);
  const unit = allocation.unit || lot.base_unit;
  const converted = await toBaseUnit(db, { id: lot.item_id, name: lot.item_name, base_unit: lot.base_unit }, quantity, unit);

  const available = await balanceAt(db, lot.id, location.id);
  if (converted.quantity > available) {
    throw new BadRequest(
      `${where}: only ${available} ${lot.base_unit} of ${lot.item_name} is in ${location.name}, ` +
        `and the batch asks for ${converted.quantity}. Pick another lot, or split it across two.`,
    );
  }

  return { lot, location, quantity: converted.quantity, enteredQuantity: quantity, enteredUnit: unit };
}

export async function produce(db, payload) {
  const envelope = await validateEnvelope(db, payload, { requireDevice: false });
  const hash = await payloadHash(payload);
  const existing = await alreadyAccepted(db, envelope.idempotency_key, hash);
  if (existing) return { duplicate: true, ...(await batchResult(db, existing.id)) };

  const lotId = requireUlid(payload.lot_id, 'lot_id');
  if (await lookupRow(db, 'SELECT id FROM lots WHERE id = ?', lotId)) {
    throw new BadRequest(`lot ${lotId} already exists: mint a new one rather than reusing it`);
  }

  const { item, recipe } = await productAndRecipe(db, payload.item_id);

  // Confirmed before starting, as the current form asks. Required rather than
  // defaulted: a tick nobody made is not a check anybody did.
  if (typeof payload.equipment_checked !== 'boolean') {
    throw new BadRequest('equipment_checked must be true or false — it is an attestation, not an optional tick');
  }

  // A double batch is the recipe twice over. Recorded rather than worked out
  // from what was used, because inferring it would make every yield
  // comparison circular.
  const multiplier = payload.multiplier === undefined ? 1 : payload.multiplier;
  if (typeof multiplier !== 'number' || !(multiplier > 0)) {
    throw new BadRequest(`multiplier must be a positive number, got ${JSON.stringify(payload.multiplier)}`);
  }

  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new BadRequest('lines must be a non-empty array: a batch made from nothing is not a batch');
  }

  // Every line is checked before anything is written, so a batch is recorded
  // whole or not at all.
  const consumed = [];
  const unproven = [];
  for (const [index, line] of payload.lines.entries()) {
    const where = `lines[${index}]`;
    const ingredient = await lookupRow(db, 'SELECT id, name, base_unit FROM items WHERE id = ?', line.item_id);
    if (!ingredient) throw new BadRequest(`${where}: unknown item ${JSON.stringify(line.item_id)}`);

    if (line.unproven) {
      const reason = typeof line.unproven.reason === 'string' ? line.unproven.reason.trim() : '';
      if (reason.length < 3) {
        throw new BadRequest(
          `${where}: an ingredient with no identified lot needs a reason — ` +
            'that reason is the only thing that makes the gap reviewable later',
        );
      }
      unproven.push({
        ingredient,
        quantity: requireQuantity(line.unproven.quantity, `${where}.unproven.quantity`),
        unit: line.unproven.unit || ingredient.base_unit,
        reason,
      });
      continue;
    }

    if (!Array.isArray(line.allocations) || line.allocations.length === 0) {
      throw new BadRequest(
        `${where}: name the lots this came from, or record it as unproven with a reason`,
      );
    }
    for (const [at, allocation] of line.allocations.entries()) {
      const prepared = await prepareAllocation(db, allocation, `${where}.allocations[${at}]`, envelope);
      if (prepared.lot.item_id !== ingredient.id) {
        throw new BadRequest(
          `${where}.allocations[${at}]: that lot is ${prepared.lot.item_name}, not ${ingredient.name}`,
        );
      }
      consumed.push(prepared);
    }
  }

  // Two lots of the same ingredient are ordinary; the same lot twice in one
  // batch is a slip that would consume it twice over.
  const lotIds = consumed.map((row) => `${row.lot.id}@${row.location.id}`);
  if (new Set(lotIds).size !== lotIds.length) {
    throw new BadRequest('the same lot is listed twice from the same place: combine those lines');
  }

  let shortCode = null;
  if (payload.short_code) {
    if (!isCode(payload.short_code)) throw new BadRequest(`short_code is not a valid code: ${payload.short_code}`);
    const held = await lookupRow(db, 'SELECT code, lot_id FROM short_codes WHERE code = ?', payload.short_code);
    if (!held) throw new BadRequest(`short code ${payload.short_code} was never issued`);
    if (held.lot_id) throw new BadRequest(`short code ${payload.short_code} is already bound to lot ${held.lot_id}`);
    shortCode = held.code;
  }

  const useBy = recipe?.shelf_life_days ? deriveUseBy(envelope.occurred_at, recipe.shelf_life_days) : null;

  // The checks the batch was made under. Planned before anything is written,
  // so a missing required reading refuses the batch rather than leaving one
  // recorded with a hole in its safety record.
  const defined = recipe ? await checkpointsFor(db, recipe.id) : [];
  const { rows: readings } = planReadings(defined, {}, lotId, envelope.event_id, envelope);

  const statements = [
    eventRow(db, envelope, 'produce', hash, payload),
    db
      .prepare(
        `INSERT INTO lots (id, item_id, short_code, batch_code, origin, originated_at,
                           use_by, use_by_source, event_id, note)
         VALUES (?, ?, ?, ?, 'produced', ?, ?, ?, ?, ?)`,
      )
      .bind(
        lotId,
        item.id,
        shortCode,
        payload.batch_code ?? null,
        envelope.occurred_at,
        useBy,
        useBy ? 'shelf_life_rule' : null,
        envelope.event_id,
        payload.note ?? null,
      ),
  ];

  if (shortCode) {
    statements.push(
      db
        .prepare("UPDATE short_codes SET lot_id = ?, bound_at = datetime('now') WHERE code = ? AND lot_id IS NULL")
        .bind(lotId, shortCode),
    );
  }

  // The counterpart is the genealogy edge: one step back from this product is
  // the lots these rows name.
  for (const [index, row] of consumed.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO movements (id, lot_id, type, quantity, entered_quantity, entered_unit,
                                  from_location_id, counterpart_lot_id, occurred_at, staff_id, event_id)
           VALUES (?, ?, 'CONSUME', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${envelope.event_id}-CONSUME-${index}`,
          row.lot.id,
          -row.quantity,
          row.enteredQuantity,
          row.enteredUnit,
          row.location.id,
          lotId,
          envelope.occurred_at,
          envelope.staff_id,
          envelope.event_id,
        ),
    );
  }

  for (const [index, row] of unproven.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO unproven_inputs (id, event_id, lot_id, item_id, quantity, unit, reason, staff_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `${envelope.event_id}-UNPROVEN-${index}`,
          envelope.event_id,
          lotId,
          row.ingredient.id,
          row.quantity,
          row.unit,
          row.reason,
          envelope.staff_id,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO batch_records (lot_id, event_id, recipe_id, multiplier,
                                    equipment_checked, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        lotId,
        envelope.event_id,
        recipe?.id ?? null,
        multiplier,
        payload.equipment_checked ? 1 : 0,
        payload.note ?? null,
      ),
  );

  for (const row of readings) {
    statements.push(readingRow(db, row, lotId, envelope.event_id, envelope));
  }

  await db.batch(statements);
  return { duplicate: false, ...(await batchResult(db, envelope.event_id)) };
}

export async function batchResult(db, eventId) {
  const [lot, movements, unproven, checks] = await Promise.all([
    db
      .prepare(
        `SELECT l.id, l.short_code, l.use_by, l.use_by_source, l.status, i.name AS item_name, i.base_unit
           FROM lots l JOIN items i ON i.id = l.item_id WHERE l.event_id = ? AND l.origin = 'produced'`,
      )
      .bind(eventId)
      .first(),
    db
      .prepare(
        `SELECT m.id, m.lot_id, m.type, m.quantity, m.entered_quantity, m.entered_unit,
                i.name AS item_name, l.short_code
           FROM movements m JOIN lots l ON l.id = m.lot_id JOIN items i ON i.id = l.item_id
          WHERE m.event_id = ? ORDER BY m.type DESC, m.id`,
      )
      .bind(eventId)
      .all(),
    db
      .prepare(
        `SELECT u.item_id, i.name AS item_name, u.quantity, u.unit, u.reason
           FROM unproven_inputs u JOIN items i ON i.id = u.item_id WHERE u.event_id = ?`,
      )
      .bind(eventId)
      .all(),
    db
      .prepare(
        `SELECT c.label, c.kind, c.is_ccp, r.celsius, r.confirmed, r.observed_at,
                r.within_limit, r.due_at, r.recorded_at
           FROM checkpoint_readings r JOIN checkpoints c ON c.id = r.checkpoint_id
          WHERE r.event_id = ? ORDER BY c.sort_order`,
      )
      .bind(eventId)
      .all(),
  ]);
  return {
    event_id: eventId,
    lot,
    movements: movements.results || [],
    unproven: unproven.results || [],
    checkpoints: checks.results || [],
  };
}
