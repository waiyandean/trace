-- P5 — Count: the weekly count that closes the books.
--
-- A count compares what the ledger computes against what is physically on the
-- shelf and writes the difference as `ADJUST` movements. Without it, variance
-- accumulates with nothing to correct it and the balances become fiction
-- within months (PLAN.md, "The model"). The old stockcheck was a third,
-- separately keyed catalog that was never joined to anything, so it could
-- never play this role.
--
-- Two decisions from Dean (2026-09-09) shape the tables:
--
-- 1. **Granularity is item + location, not per lot.** Staff record one
--    counted figure per item per storage area. A countable jar cannot be
--    part-used so its lot is never in doubt anyway, and a part-used bulk tub
--    cannot be counted per lot at all — so the count never asks the floor for
--    something it cannot answer. `count_lines` is therefore keyed on
--    (count, item, location), not on a lot.
--
-- 2. **A variance is apportioned across the item's open lots at that location
--    pro-rata by each lot's ledger balance.** The count cannot see which lot
--    the discrepancy came from, so it assumes nothing and spreads it by
--    weight. Pro-rata by a positive balance also cannot drive any lot below
--    zero: a shortfall of at most the whole balance, split in proportion to
--    each lot's share, leaves every lot at or above nothing.
--
-- Like the stock and dispatch screens, a count is online-only and needs no
-- device: it mints no short codes, and it is measured against live balances
-- that a cached copy would get wrong the moment someone else moved stock.
-- The `events.kind` list already allows 'count', and `movements.type`
-- already allows 'ADJUST', so neither of those moves here.

-- One row per count submission: the sheet as a whole.
CREATE TABLE counts (
  event_id   TEXT PRIMARY KEY REFERENCES events (id),
  counted_at TEXT NOT NULL,
  counted_by TEXT NOT NULL REFERENCES staff (id),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX counts_counted_at ON counts (counted_at);

-- One row per (item, location) line on the sheet. The counted figure, the
-- ledger figure it was measured against, and how the difference was resolved.
CREATE TABLE count_lines (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES counts (event_id),
  item_id     TEXT NOT NULL REFERENCES items (id),
  location_id TEXT NOT NULL REFERENCES locations (id),

  -- What staff physically counted, converted to the item's base unit, with
  -- the raw figure they keyed and its unit kept beside it — the same pattern
  -- `movements` uses, so a wrong conversion factor can be told from a wrong
  -- entry after the fact.
  counted_quantity REAL NOT NULL CHECK (counted_quantity >= 0),
  entered_quantity REAL,
  entered_unit     TEXT,

  -- The ledger's computed balance for this item at this location at the
  -- moment the count was recorded. A snapshot, not a live read: it is what
  -- the variance was measured against, and a later recompute could quietly
  -- change it if any movement since carried a backdated occurred_at.
  ledger_quantity  REAL NOT NULL,

  -- counted_quantity - ledger_quantity, stored so no report has to trust the
  -- subtraction was done the same way twice.
  variance         REAL NOT NULL,

  -- How the variance was resolved:
  --   no_variance  the counted figure matched the ledger; nothing written
  --   apportioned  one ADJUST per open lot at this location, pro-rata by
  --                balance
  --   unresourced  stock was counted with no open lot at this location to
  --                carry it. No ADJUST is written — the system will not
  --                invent a lot to balance to — and the line is left for a
  --                human to resolve, surfaced by GET /api/counts?open.
  disposition      TEXT NOT NULL
                     CHECK (disposition IN ('no_variance', 'apportioned', 'unresourced')),

  -- Set by hand once somebody has dealt with an 'unresourced' line: found the
  -- missing delivery, opened a lot, corrected the sheet. Same shape as the
  -- unproven-input review from P3.
  resolved_at   TEXT,
  resolved_by   TEXT REFERENCES staff (id),
  resolve_note  TEXT,

  created_at    TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (event_id, item_id, location_id),

  -- A resolution names a person and a moment or neither.
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);

CREATE INDEX count_lines_event ON count_lines (event_id);
CREATE INDEX count_lines_item ON count_lines (item_id, location_id);
CREATE INDEX count_lines_unresolved ON count_lines (disposition, resolved_at);
