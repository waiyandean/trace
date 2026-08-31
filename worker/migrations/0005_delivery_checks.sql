-- P1 — the half of goods-in that is not traceability.
--
-- The live form records a food-safety check on every delivery, and the ledger
-- built so far records none of them. A delivery booked into trace as it stood
-- would be traceable but not compliant: no vehicle temperature, no product
-- temperature, no allergen confirmation. That is an EHO-facing loss, so these
-- tables exist before trace is allowed to replace anything.
--
-- Shapes and limits are taken from the kitchen's own 411 goods intake records
-- rather than from a standard, with two answers from Dean on 2026-08-31 where
-- the records could not say.

-- What "acceptable" means, as data rather than as a constant in the code.
-- An auditor asks what the limit was at the time, so readings below store the
-- limit they were judged against and this table only says what is current.
CREATE TABLE temperature_limits (
  kind        TEXT PRIMARY KEY CHECK (kind IN ('chilled', 'frozen')),
  celsius     REAL NOT NULL,
  note        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chilled at 5 rather than the legal 8 is the kitchen's own line (Dean,
-- 2026-08-31): every chilled reading in the history is 4 or 5, so 5 catches
-- drift while it is still drift. Frozen at -18 is read off the kitchen's one
-- existing deviation record, which judged a reading against "≤-18".
INSERT INTO temperature_limits (kind, celsius, note) VALUES
  ('chilled', 5,   'kitchen limit, tighter than the legal 8 (Dean, 2026-08-31)'),
  ('frozen',  -18, 'from the kitchen''s existing deviation records');

-- One row per delivery: the checks that are about the delivery as a whole
-- rather than about any one line.
--
-- "Storage OK" from the old form is deliberately absent. It was filled on 18
-- of 411 records, and a field nobody fills teaches staff that fields can be
-- skipped. If it matters it should be brought back as something that is
-- actually asked.
CREATE TABLE delivery_checks (
  event_id            TEXT PRIMARY KEY REFERENCES events (id),

  vehicle_condition   TEXT NOT NULL CHECK (vehicle_condition IN ('good', 'poor')),
  vehicle_note        TEXT,

  -- Attestations. Every one of the 411 historical records says yes, which is
  -- either a well-run kitchen or a form nobody can say no to. They are stored
  -- as 0/1 rather than as a tick that only goes one way, so that a "no" is
  -- expressible and visible when it happens.
  condition_ok        INTEGER NOT NULL CHECK (condition_ok IN (0, 1)),
  labels_applied      INTEGER NOT NULL CHECK (labels_applied IN (0, 1)),
  allergens_confirmed INTEGER NOT NULL CHECK (allergens_confirmed IN (0, 1)),

  note                TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every temperature anybody took, in or out of limit. The in-limit ones are
-- the evidence that the check happened at all, so they are kept rather than
-- only recording the failures.
CREATE TABLE temperature_readings (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events (id),

  -- Null for a vehicle reading, which is about the van rather than any one
  -- lot in it.
  lot_id        TEXT REFERENCES lots (id),

  kind          TEXT NOT NULL CHECK (kind IN ('vehicle_chilled', 'vehicle_frozen', 'product')),
  celsius       REAL NOT NULL,

  -- The limit as it stood when this was judged, copied rather than joined.
  -- If the kitchen tightens its limit next year, last year's readings must
  -- still show what they were measured against.
  limit_celsius REAL NOT NULL,
  within_limit  INTEGER NOT NULL CHECK (within_limit IN (0, 1)),

  staff_id      TEXT NOT NULL REFERENCES staff (id),
  recorded_at   TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX temperature_readings_event ON temperature_readings (event_id);
CREATE INDEX temperature_readings_lot ON temperature_readings (lot_id);
CREATE INDEX temperature_readings_breaches ON temperature_readings (within_limit, recorded_at);

-- A reading outside its limit opens one of these, and the affected lots are
-- held until somebody records what happened.
--
-- Modelled on the kitchen's existing deviation record, including its
-- half-hour recheck window. That record is also the argument for making the
-- hold do something: its recheck was due at 14:02 and was actually taken
-- seven days later. A deviation nothing blocks is a deviation nothing chases.
CREATE TABLE temperature_deviations (
  id              TEXT PRIMARY KEY,
  reading_id      TEXT NOT NULL REFERENCES temperature_readings (id),
  lot_id          TEXT REFERENCES lots (id),

  opened_at       TEXT NOT NULL,
  recheck_due_at  TEXT NOT NULL,

  rechecked_at    TEXT,
  recheck_celsius REAL,

  -- 'resolved'  the recheck was within limit and the stock is usable
  -- 'rejected'  sent back with the supplier
  -- 'disposed'  thrown away, which must also write a WASTE movement
  outcome         TEXT CHECK (outcome IN ('resolved', 'rejected', 'disposed')),
  outcome_note    TEXT,
  closed_at       TEXT,
  closed_by       TEXT REFERENCES staff (id),

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  -- An outcome without the person and the moment is half a record.
  CHECK ((outcome IS NULL) = (closed_at IS NULL)),
  CHECK ((outcome IS NULL) = (closed_by IS NULL))
);

CREATE INDEX temperature_deviations_open ON temperature_deviations (outcome, recheck_due_at);
CREATE INDEX temperature_deviations_lot ON temperature_deviations (lot_id);
