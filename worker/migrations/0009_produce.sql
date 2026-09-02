-- P3 — Produce: a batch, and what went into it.
--
-- A batch is one event that consumes from identified lots and opens a new lot
-- of the product. The consuming and the producing are movements, so stock on
-- hand and genealogy both fall out of the ledger with no special case.
--
-- What needs a table of its own is the exception. Sometimes the physical lot
-- genuinely is not in the system — a case with no label, stock that predates
-- the rollout — and the kitchen's answer (Dean, 2026-08-31) is that the batch
-- proceeds and the gap is recorded rather than blocked or guessed at.
--
-- It cannot be a movement, because a movement needs a lot and the whole point
-- is that there is not one. So it is recorded here, against the batch, and it
-- is what a one-step-back report has to show as unproven rather than absent.
CREATE TABLE unproven_inputs (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events (id),

  -- The batch this went into.
  lot_id     TEXT NOT NULL REFERENCES lots (id),

  -- What it was is known; which lot it came from is not.
  item_id    TEXT NOT NULL REFERENCES items (id),
  quantity   REAL NOT NULL CHECK (quantity > 0),
  unit       TEXT NOT NULL,

  -- Why no lot could be identified. Required: an unproven input with no
  -- explanation is indistinguishable from a form somebody rushed, and the
  -- reason is the only thing that makes the gap reviewable afterwards.
  reason     TEXT NOT NULL,

  staff_id   TEXT NOT NULL REFERENCES staff (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX unproven_inputs_lot ON unproven_inputs (lot_id);
CREATE INDEX unproven_inputs_item ON unproven_inputs (item_id, created_at);
