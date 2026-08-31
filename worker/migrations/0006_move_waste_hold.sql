-- P2 — store, move, waste.
--
-- Stock could arrive and never leave. Without this, anything that goes is
-- unexplained loss: the weekly count in P5 would show a shortfall with no way
-- to say whether it was thrown away, moved to the freezer, or never there.
-- That is why waste comes early rather than late.
--
-- `MOVE` and `WASTE` are already in the movements table's type list, so
-- nothing changes there. What is missing is a controlled reason for waste, and
-- a hold that is not about temperature.

-- Why stock was thrown away. A vocabulary rather than free text, because
-- "why do we throw away the most of X" is the question the log exists to
-- answer, and free text cannot be counted.
--
-- Chosen with Dean, 2026-08-31. Trim and preparation loss is deliberately not
-- here: bones and peel are a yield matter belonging to the recipe at batching,
-- not an incident, and putting them in the waste log would bury the three
-- reasons that need looking at under the one that is simply normal.
CREATE TABLE waste_reasons (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,

  -- Whether staff can pick it. A reason the system writes for itself should
  -- not also be a button somebody can press.
  staff_selectable INTEGER NOT NULL DEFAULT 1 CHECK (staff_selectable IN (0, 1)),

  sort_order       INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO waste_reasons (id, name, staff_selectable, sort_order, note) VALUES
  ('waste:out-of-date', 'Out of date', 1, 1,
   'passed its use-by before it was used — the one that shows an ordering or rotation problem'),
  ('waste:damaged', 'Damaged or spoiled', 1, 2,
   'crushed, split packaging, off smell, freezer burn'),
  ('waste:spillage', 'Spillage or dropped', 1, 3,
   'an accident in handling, kept apart from spoilage because the fix is different'),
  ('waste:temperature', 'Failed a temperature check', 0, 4,
   'written by the system when a temperature deviation is closed as disposed');

-- SQLite cannot add a CHECK to an existing table, so "a WASTE movement must
-- name a reason, and nothing else may" is enforced in the endpoint and by its
-- tests rather than here. Stated plainly so the gap is known rather than
-- discovered.
ALTER TABLE movements ADD COLUMN waste_reason_id TEXT REFERENCES waste_reasons (id);

-- A hold that is not about temperature: a supplier recall, a quality doubt, a
-- label that came off. Temperature holds already live in
-- temperature_deviations, and both hold the same way — a lot is usable only
-- when nothing at all is holding it.
CREATE TABLE holds (
  id           TEXT PRIMARY KEY,
  lot_id       TEXT NOT NULL REFERENCES lots (id),

  reason       TEXT NOT NULL,
  opened_at    TEXT NOT NULL,
  opened_by    TEXT NOT NULL REFERENCES staff (id),
  event_id     TEXT NOT NULL REFERENCES events (id),

  released_at  TEXT,
  released_by  TEXT REFERENCES staff (id),
  release_note TEXT,

  created_at   TEXT NOT NULL DEFAULT (datetime('now')),

  -- A release without the person and the moment is half a record, the same
  -- rule the temperature deviations follow.
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE INDEX holds_open ON holds (lot_id, released_at);
