-- P3 — reviewing an unproven input.
--
-- The batch is not gated on this: PLAN.md already settled that a block at the
-- pot is worked around with a plausible wrong lot, which is worse than an
-- honest gap. So the weight moves to here instead, in the same shape as a
-- temperature deviation — nobody stops the batch, but the gap stays open
-- until a named person has looked at it and said so.
--
-- Unlike a deviation there is nothing to resolve: the ingredient is already
-- in the pot and cannot be un-used. Reviewing is acknowledgement, not an
-- outcome, so there is no equivalent of "rejected" or "disposed" — just who
-- looked at it, when, and anything they noted.
ALTER TABLE unproven_inputs ADD COLUMN reviewed_at TEXT;
ALTER TABLE unproven_inputs ADD COLUMN reviewed_by TEXT REFERENCES staff (id);
ALTER TABLE unproven_inputs ADD COLUMN review_note TEXT;

CREATE INDEX unproven_inputs_open ON unproven_inputs (reviewed_at, created_at);
