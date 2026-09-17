import { BadRequest } from '../http.js';
import { validateEnvelope, payloadHash, alreadyAccepted, eventRow, requireDate } from './envelope.js';

// Recording that a pack was opened. PLAN.md's open item 4 settled the rule
// back in P0 (items.opening_rule, items.days_after_opening) and named this
// as the one thing still missing: "the event: recording that a pack was
// opened, and applying the rule to that lot's use-by." No quantity moves and
// nowhere changes — this is a state change on the lot, the same shape as a
// hold, not a movement.

// The use-by after opening, from the item's own rule (HANDOFF.md, open item
// 4, "Opening a pack" — Dean, 2026-08-31):
//   shortens   — the earlier of the pack's own use-by and this many days
//                from opening.
//   no_change  — opening changes storage, not shelf life.
//   whole_pack — never partly used, so there is nothing to open and no
//                Date Opened label at all; refused before this is called.
export function afterOpening(rule, existingUseBy, openedAt, days) {
  if (rule === 'no_change') return { useBy: existingUseBy, source: null };
  const opened = new Date(`${openedAt}T00:00:00Z`);
  const derived = new Date(opened);
  derived.setUTCDate(derived.getUTCDate() + days);
  const derivedIso = derived.toISOString().slice(0, 10);
  if (!existingUseBy || derivedIso < existingUseBy) return { useBy: derivedIso, source: 'opened_rule' };
  return { useBy: existingUseBy, source: null };
}

export async function recordOpening(db, payload) {
  const envelope = await validateEnvelope(db, payload, { requireDevice: false });
  const hash = await payloadHash(payload);
  const existing = await alreadyAccepted(db, envelope.idempotency_key, hash);
  if (existing) return { duplicate: true, event_id: existing.id };

  const openedOn = requireDate(payload.opened_on, 'opened_on');

  const lot = await db
    .prepare(
      `SELECT l.id, l.status, l.opened_at, l.use_by, l.short_code, l.batch_code,
              i.id AS item_id, i.name AS item_name, i.kind, i.base_unit,
              i.opening_rule, i.days_after_opening, i.storage_opened
         FROM lots l JOIN items i ON i.id = l.item_id
        WHERE l.id = ?`,
    )
    .bind(payload.lot_id)
    .first();
  if (!lot) throw new BadRequest(`unknown lot ${JSON.stringify(payload.lot_id)}`);
  if (lot.status !== 'open') throw new BadRequest(`${lot.item_name} is ${lot.status}, not open — cannot be opened`);
  if (lot.opened_at) throw new BadRequest(`${lot.item_name} was already opened, on ${lot.opened_at.slice(0, 10)}`);
  if (lot.kind !== 'ingredient') throw new BadRequest(`${lot.item_name} is not an ingredient`);
  if (!lot.opening_rule || lot.opening_rule === 'whole_pack') {
    throw new BadRequest(`${lot.item_name} is used whole — there is no Date Opened label for it`);
  }

  const { useBy, source } = afterOpening(lot.opening_rule, lot.use_by, openedOn, lot.days_after_opening);

  await db.batch([
    eventRow(db, envelope, 'open', hash, payload),
    source
      ? db.prepare('UPDATE lots SET opened_at = ?, use_by = ?, use_by_source = ? WHERE id = ?')
          .bind(envelope.occurred_at, useBy, source, lot.id)
      : db.prepare('UPDATE lots SET opened_at = ? WHERE id = ?').bind(envelope.occurred_at, lot.id),
  ]);

  return {
    duplicate: false,
    event_id: envelope.event_id,
    lot_id: lot.id,
    item_name: lot.item_name,
    short_code: lot.short_code,
    batch_code: lot.batch_code,
    base_unit: lot.base_unit,
    storage_opened: lot.storage_opened,
    opened_on: openedOn,
    use_by: useBy,
  };
}
