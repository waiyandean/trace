-- P3 — the checks a batch is made under.
--
-- Sixty checkpoints across the kitchen's products, twenty-one of them
-- critical control points. A batch recorded without them would be traceable
-- and not safe: the ledger would say which lots went into a broth and nothing
-- about whether it reached temperature.
--
-- Twelve of them have a clock. "Cooling end, 5°C within 60 minutes" is not a
-- field somebody fills in at the end — it is a reading due sixty minutes
-- after cooling started, and being late is itself the finding. So a batch
-- creates those rows unanswered, with the moment they fall due, and something
-- has to come back to them.
CREATE TABLE checkpoints (
  id                 TEXT PRIMARY KEY,
  recipe_id          TEXT NOT NULL REFERENCES recipes (id),

  -- The upstream identifier, unique within a recipe rather than globally:
  -- four products each have a "cooking-start-temp".
  code               TEXT NOT NULL,
  label              TEXT NOT NULL,

  --   temp        a reading taken at the time
  --   temp-after  a reading due a stated while after another checkpoint
  --   time        a moment recorded rather than a measurement
  --   check       something confirmed rather than measured
  kind               TEXT NOT NULL CHECK (kind IN ('temp', 'temp-after', 'time', 'check')),

  -- A critical control point. Not decoration: it is the difference between a
  -- reading somebody should take and one the law expects them to.
  is_ccp             INTEGER NOT NULL DEFAULT 0 CHECK (is_ccp IN (0, 1)),
  required           INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),

  -- Null where the kitchen states no limit, which is most of them. A
  -- checkpoint with no limit is a reading to keep, not a test to pass, and
  -- inventing a limit would turn a record into a false pass or a false alarm.
  min_celsius        REAL,
  max_celsius        REAL,

  -- Which checkpoint the clock runs from, and how long it runs for.
  anchor_code        TEXT,
  due_minutes        INTEGER CHECK (due_minutes > 0),
  min_duration_hours REAL CHECK (min_duration_hours > 0),

  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),

  -- A timed checkpoint needs something to be timed from.
  CHECK (due_minutes IS NULL OR anchor_code IS NOT NULL)
);

CREATE UNIQUE INDEX checkpoints_code_unique ON checkpoints (recipe_id, code);
CREATE INDEX checkpoints_recipe ON checkpoints (recipe_id, sort_order);

-- What was recorded against one batch.
--
-- A row exists from the moment the batch is made, including for readings that
-- are not due yet: an unanswered row with a due time is what makes a missed
-- reading visible. A checkpoint nobody created a row for is invisible, and
-- invisible is how the twelve-hour cooling check gets forgotten.
CREATE TABLE checkpoint_readings (
  id            TEXT PRIMARY KEY,
  lot_id        TEXT NOT NULL REFERENCES lots (id),
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints (id),

  -- The event that created the row, and the event that answered it. They
  -- differ for anything with a clock: the batch creates it, somebody coming
  -- back twelve hours later answers it.
  event_id      TEXT NOT NULL REFERENCES events (id),
  answered_by_event TEXT REFERENCES events (id),

  due_at        TEXT,
  recorded_at   TEXT,
  staff_id      TEXT REFERENCES staff (id),

  celsius       REAL,
  observed_at   TEXT,
  confirmed     INTEGER CHECK (confirmed IN (0, 1)),

  -- Null where the checkpoint states no limit: unjudged rather than passed.
  -- A reading kept without a limit is evidence; calling it a pass would be a
  -- claim nobody made.
  within_limit  INTEGER CHECK (within_limit IN (0, 1)),

  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),

  -- Answered means somebody and a moment, or neither.
  CHECK ((recorded_at IS NULL) = (staff_id IS NULL))
);

CREATE UNIQUE INDEX checkpoint_readings_unique ON checkpoint_readings (lot_id, checkpoint_id);
CREATE INDEX checkpoint_readings_pending ON checkpoint_readings (recorded_at, due_at);
CREATE INDEX checkpoint_readings_lot ON checkpoint_readings (lot_id);
