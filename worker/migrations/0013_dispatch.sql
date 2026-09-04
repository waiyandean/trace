-- P4 — Dispatch: produced lots leaving the building for a customer.
--
-- This is the last hop of the chain, and the one an audit actually asks
-- about: given a customer and a date, what did they get, and one step back,
-- which batches did it come from. A DISPATCH movement carries all of that —
-- it is a negative quantity against a produced lot, at the location the stock
-- left from — so genealogy and the outgoing balance both fall out of the
-- ledger with no special case, exactly as RECEIVE and CONSUME do.
--
-- Two things need a row of their own here.
--
-- 1. The customer. A movement names a lot and a place, not a destination, so
--    one `dispatches` row per submission holds the customer, the paper
--    reference, and the vehicle condition — the delivery-note-level facts
--    that are true of the whole load rather than of any one line.
--
-- 2. The transport check. Dean, 2026-09-04: the van's temperature has to be
--    right before produced stock goes on it. Unlike goods-in, where a warm
--    delivery has already happened and the lot is held pending a recheck, a
--    dispatch is prospective — nothing has left yet — so a breach is a
--    refusal at the point of loading rather than a deviation to chase later.
--    The readings that pass are still written, against the event, because a
--    passing check is the evidence an auditor asks for that the check was
--    made at all. They reuse `temperature_readings` from migration 0005;
--    no deviation or hold machinery is involved on this path.
--
-- The use-by is inherited, never recalculated (PLAN.md P4): the produced lot
-- already carries the use-by its recipe rule derived at packing, and dispatch
-- reads it straight off the lot. A second calculation here could disagree
-- with the label already on the packet.

CREATE TABLE dispatches (
  event_id          TEXT PRIMARY KEY REFERENCES events (id),

  customer_id       TEXT NOT NULL REFERENCES customers (id),

  -- The customer's order number, or the number on the paper note the kitchen
  -- prints. Free text and optional: it is their reference, not ours, and a
  -- dispatch is still a complete record without it.
  reference         TEXT,

  -- The same good/poor judgement goods-in records for an incoming vehicle.
  -- Stored as text rather than a one-way tick so a "poor" is expressible.
  vehicle_condition TEXT NOT NULL CHECK (vehicle_condition IN ('good', 'poor')),
  vehicle_note      TEXT,

  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX dispatches_customer ON dispatches (customer_id, created_at);
