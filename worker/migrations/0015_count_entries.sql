-- P5 — the count sheet keyed in the units staff actually handle.
--
-- A count line's result is still one figure in the item's base unit, and
-- everything downstream — the variance, the pro-rata ADJUSTs — only ever sees
-- that figure. But staff count "two cases, three tubs and about 400 g loose",
-- not "16.4 kg" (PLAN.md open question 4: ask in the pack unit, never a weight
-- somebody has to work out). Each tier is kept exactly as it was keyed, next
-- to what it converted to, the same way `movements` keeps entered_quantity /
-- entered_unit — so a wrong conversion factor can be told from a wrong entry
-- after the fact.
--
-- `count_lines.counted_quantity` stays the base-unit sum of these rows.
-- `count_lines.entered_quantity` / `entered_unit` keep working as the single
-- figure for a one-tier line, and are null when a line has several tiers.
CREATE TABLE count_line_entries (
  id               TEXT PRIMARY KEY,
  count_line_id    TEXT NOT NULL REFERENCES count_lines (id),

  -- What the person keyed for this tier, and its unit as offered on screen
  -- ('case', 'item', or the item's base unit).
  entered_quantity REAL NOT NULL CHECK (entered_quantity > 0),
  entered_unit     TEXT NOT NULL,

  -- The tier converted to the item's base unit through the conversions
  -- master, so the line total can be re-derived without re-running the graph.
  base_quantity    REAL NOT NULL CHECK (base_quantity > 0),

  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX count_line_entries_line ON count_line_entries (count_line_id);
