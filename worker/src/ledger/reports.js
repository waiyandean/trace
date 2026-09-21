import { BadRequest } from '../http.js';
import { openDeviations } from './deviations.js';
import { openHolds } from './stock.js';
import { openUnproven } from './unproven.js';
import { openCountLines } from './count.js';

// P6 — Reports. PLAN.md: "One-step-back, one-step-forward, mass balance, and
// alerts for missing lots, negative balances and conflicting dates. Simple
// versions of these are built alongside P1–P5 to validate the data model as
// it grows; P6 is where they become the finished operational views."
//
// Mass balance already exists per batch (packing.js massBalance) and is left
// there — it belongs beside the batch it explains. What P6 adds is what
// nothing else needed yet: tracing a lot's one-hop genealogy either
// direction, and a single bundled view of every alert that was previously
// only visible from the screen that happened to write it.

const LOT_ROW = `SELECT l.id, l.item_id, i.name AS item_name, i.base_unit, l.short_code, l.batch_code,
                        l.origin, l.status, l.use_by, l.use_by_source, l.originated_at
                   FROM lots l JOIN items i ON i.id = l.item_id WHERE l.id = ?`;

// The genealogy edge is the CONSUME movement: it sits on the lot consumed,
// and names the lot it fed via counterpart_lot_id (produce.js). So one step
// back from a lot is who fed it — CONSUME rows pointing at it as the
// counterpart — and one step forward is what it fed — CONSUME rows written
// against it directly.
const EDGE_COLUMNS = `l.id, i.name AS item_name, i.base_unit, l.short_code, l.batch_code,
                       l.status, ABS(m.quantity) AS quantity, m.occurred_at`;

async function traceBack(db, lotId) {
  const { results } = await db
    .prepare(
      `SELECT ${EDGE_COLUMNS} FROM movements m
        JOIN lots l ON l.id = m.lot_id JOIN items i ON i.id = l.item_id
       WHERE m.counterpart_lot_id = ? AND m.type = 'CONSUME'
       ORDER BY i.name`,
    )
    .bind(lotId)
    .all();
  return results || [];
}

async function traceForward(db, lotId) {
  const { results } = await db
    .prepare(
      `SELECT ${EDGE_COLUMNS} FROM movements m
        JOIN lots l ON l.id = m.counterpart_lot_id JOIN items i ON i.id = l.item_id
       WHERE m.lot_id = ? AND m.type = 'CONSUME'
       ORDER BY i.name`,
    )
    .bind(lotId)
    .all();
  return results || [];
}

// A lot's one-hop genealogy both ways: what fed it, and what it fed. Beyond
// one hop is composition — call this again on a lot the first call returned
// — rather than a recursive query here, matching the phase as PLAN.md scopes
// it rather than the full multi-hop trace the model section describes.
export async function traceLot(db, lotId) {
  if (!lotId) throw new BadRequest('lot is required');
  const lot = await db.prepare(LOT_ROW).bind(lotId).first();
  if (!lot) throw new BadRequest(`no lot ${JSON.stringify(lotId)}`);

  const [back, forward] = await Promise.all([traceBack(db, lotId), traceForward(db, lotId)]);
  return { lot, back, forward };
}

// Every lot-location pair should never carry a negative balance — the
// application refuses a MOVE, WASTE, CONSUME or DISPATCH that would take one
// below zero. This is the check that the refusal actually held, not a path
// anything is expected to take: a row here is a bug, not an operational
// event, and is reported as one.
export async function negativeBalances(db) {
  const { results } = await db
    .prepare(
      `WITH balances AS (
         SELECT lot_id, COALESCE(to_location_id, from_location_id) AS location_id, SUM(quantity) AS quantity
           FROM movements GROUP BY lot_id, location_id
       )
       SELECT l.id AS lot_id, i.name AS item_name, i.base_unit, l.short_code,
              loc.id AS location_id, loc.name AS location_name, b.quantity
         FROM balances b
         JOIN lots l ON l.id = b.lot_id
         JOIN items i ON i.id = l.item_id
         JOIN locations loc ON loc.id = b.location_id
        WHERE b.quantity < 0
        ORDER BY i.name`,
    )
    .all();
  return results || [];
}

// A lot whose use-by is not after the day it came into being: a supplier's
// date mistyped, or a shelf-life rule applied to the wrong day. Closed and
// written-off lots are excluded — a lot closed by a correction can carry a
// use-by from before that correction, and it is done, not actionable.
export async function conflictingDates(db) {
  const { results } = await db
    .prepare(
      `SELECT l.id AS lot_id, i.name AS item_name, l.short_code, l.batch_code, l.status,
              l.origin, l.originated_at, l.use_by, l.use_by_source
         FROM lots l JOIN items i ON i.id = l.item_id
        WHERE l.use_by IS NOT NULL
          AND date(l.use_by) <= date(l.originated_at)
          AND l.status NOT IN ('closed', 'written_off')
        ORDER BY l.originated_at DESC`,
    )
    .all();
  return results || [];
}

// The bundled operational view P6 asks for: every alert this system can
// raise, in one place, rather than each visible only from the one screen
// that happened to write it. Each of the first four already had its own
// endpoint for the screen that surfaces it day to day (goods-in's
// deviations, stock's holds, batches' unproven, count's unresourced lines);
// this composes them alongside the two P6 adds that nothing wrote yet.
export async function alerts(db) {
  const [deviations, holds, unproven, unresourced, negative, dates] = await Promise.all([
    openDeviations(db),
    openHolds(db),
    openUnproven(db),
    openCountLines(db),
    negativeBalances(db),
    conflictingDates(db),
  ]);
  return {
    deviations,
    holds,
    unproven,
    unresourced,
    negative_balances: negative,
    conflicting_dates: dates,
    total: deviations.length + holds.length + unproven.length + unresourced.length
      + negative.length + dates.length,
  };
}
