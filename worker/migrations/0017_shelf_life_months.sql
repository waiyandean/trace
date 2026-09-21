-- P3 — shelf life in whole months, landing on the first, not raw days.
--
-- HANDOFF.md: "Shelf life is 12 months for the broths and 6 for everything
-- else, counted in whole months onto the first of that month." recipes had
-- shelf_life_days instead, which deriveUseBy simply added to the packed
-- date — a batch packed 16 September with 360 "days" landed on 11 September
-- the following year, not the 1st of September the rule actually calls for.
-- Whole months and whole days are not interchangeable arithmetic (months
-- vary in length), so this replaces the column rather than reinterpreting
-- it. Nothing has been deployed to the remote database yet (PLAN.md: the
-- live Worker is still the P0 read-only build), so there is no production
-- data this could lose. labels/gui's months_on() already implements the
-- correct arithmetic (server.py) and is what produce.js's deriveUseBy is
-- rewritten to match.
ALTER TABLE recipes ADD COLUMN shelf_life_months INTEGER CHECK (shelf_life_months > 0);

-- Twelve for the broths, six for everything else (HANDOFF.md, 2026-09-01,
-- via PLAN.md's P0 progress note) — backfilled by name rather than left
-- null, since every recipe existing today already has a real days figure
-- that was standing in for exactly this rule.
UPDATE recipes SET shelf_life_months = 12
  WHERE item_id IN (SELECT id FROM items WHERE name IN ('Chicken Broth', 'Tonkotsu Broth'));
UPDATE recipes SET shelf_life_months = 6
  WHERE shelf_life_months IS NULL AND shelf_life_days IS NOT NULL;

ALTER TABLE recipes DROP COLUMN shelf_life_days;
