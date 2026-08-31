-- Primary supplier versus emergency backup.
--
-- Seven ingredients arrive from both Lynas and Tazaki, and the pairings are
-- all genuine — but they are not equal. Tazaki is where these are normally
-- bought; Lynas is who the kitchen falls back to when Tazaki cannot supply
-- (Dean, 2026-08-31).
--
-- Recording that is what lets the picker be both clean and complete. Under
-- Tazaki these are ordinary stock. Under Lynas they are still there, because
-- a Lynas delivery of them is a real thing that happens and hiding it would
-- strand somebody at the door — but they are set apart, so the everyday grid
-- is not padded with the exceptional case.
--
-- Defaulting to 'primary' is right for every existing row: a sole supplier is
-- by definition the primary one, and the seven backups are set explicitly by
-- the importer.
ALTER TABLE item_suppliers
  ADD COLUMN role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'backup'));
