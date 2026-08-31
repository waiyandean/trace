-- What opening a pack does to it.
--
-- Three different things happen in this kitchen (Dean, 2026-08-31), and the
-- catalog could not tell them apart:
--
--   shortens    the pack says "consume within N days of opening", so an
--               opened pack's use-by is the earlier of its own date and N
--               days from the day it was opened
--   no_change   opening changes how it is stored but not how long it lasts —
--               "once opened, keep refrigerated", with no period given
--   whole_pack  the pack is never partly used, so opening is not a thing that
--               happens to it and no Date Opened label is printed
--
-- Seventeen ingredients get a Date Opened label; the rest are used whole.
--
-- Null means "not yet determined", the same discipline the rest of the
-- catalog follows. It is deliberately not defaulted to whole_pack: an item
-- nobody has looked at yet and an item somebody decided is used whole must
-- stay distinguishable, or a missed one silently loses its label.
ALTER TABLE items ADD COLUMN opening_rule TEXT
  CHECK (opening_rule IN ('shortens', 'no_change', 'whole_pack'));

-- Days, and only meaningful with 'shortens'. SQLite cannot add a CHECK to an
-- existing table, so "a period belongs to a shortens rule and to nothing
-- else" is enforced by the importer and its tests rather than here. Stated so
-- the gap is known rather than found.
ALTER TABLE items ADD COLUMN days_after_opening INTEGER;
