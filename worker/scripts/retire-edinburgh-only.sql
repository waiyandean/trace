-- Retires the ten ingredients confirmed Edinburgh-site-only, not held at
-- Glasgow (Dean, 2026-09-25, confirming the note already on nine of these
-- in catalog-overrides.json's "excluded" block; Spinach was missing from
-- that list and has been added there too).
--
-- This does what a full re-import would already do -- scripts/import_catalog.py's
-- exclusion() sets active=0 with a note for anything in "excluded" -- run
-- directly because no workbook file is available here to re-run the import
-- itself. Setting active=0 rather than deleting: retired, not erased, so any
-- lot history referencing these ids stays intact and they can still be seen
-- with active=all.
--
-- Run with: npx wrangler d1 execute trace --remote --file scripts/retire-edinburgh-only.sql

UPDATE items SET
  active = 0,
  note = 'Excluded: used at Edinburgh only, not held at Glasgow (Dean, 2026-09-25)',
  updated_at = datetime('now')
WHERE id IN (
  'mpv49dty4hdf',  -- Carrots
  'mpv4ep7cxb5t',  -- Chicken Powder
  'mpv46rcpaytv',  -- Chinese Leaves
  'mpuzhbhus7w8',  -- Dark Soy Sauce
  'mpuzrf5htyrc',  -- Hoi Sin Sauce Cans
  'mpv4dmq37alr',  -- Medium Eggs
  'mpv43vqscfkx',  -- Spinach
  'mpv4frxnle13',  -- Sriracha Chilli Sauce
  'mpv4gpc6mcvn',  -- Tomato Ketchup
  'mpv4j0ic2j14'   -- Tomato Puree Paste
);
