-- P0 — Foundations: the catalog.
--
-- These are the reference tables the ledger points at. No lots, movements,
-- events or amendments here; those arrive with P1, when there is a form that
-- writes them. Everything in this file is data the kitchen maintains rather
-- than data a submission produces.
--
-- Ids are text throughout. Catalog rows are created by an import or by an
-- admin screen, never offline on a device, so they do not need the
-- client-minted ULIDs that lots will use.

CREATE TABLE items (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('ingredient', 'packaging', 'product')),
  base_unit         TEXT NOT NULL CHECK (base_unit IN ('kg', 'L', 'Units')),

  -- Fallback only. The use-by printed on the supplier's box always wins; this
  -- is what intake applies when a delivery arrives with no printed date
  -- (PLAN.md open question 5). Seven days covers the catalog, so per-item
  -- values are overrides rather than a figure that must be agreed up front.
  shelf_life_days   INTEGER NOT NULL DEFAULT 7 CHECK (shelf_life_days > 0),

  -- Two storage requirements, not one. Several ingredients sit on an ambient
  -- shelf unopened and must be refrigerated once opened, and it is the
  -- after-opening state the Date Opened label prints.
  storage_unopened  TEXT NOT NULL CHECK (storage_unopened IN ('ambient', 'chill', 'freezer')),
  storage_opened    TEXT NOT NULL CHECK (storage_opened   IN ('ambient', 'chill', 'freezer')),

  -- Whether this product's label carries the oval health mark. A compliance
  -- determination held per item, not inferred from the recipe: the broths
  -- need it, most sauces and oils do not. Null for anything that is not a
  -- product, since the question does not apply.
  needs_health_mark INTEGER CHECK (needs_health_mark IN (0, 1)),

  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (kind = 'product' OR needs_health_mark IS NULL)
);

CREATE UNIQUE INDEX items_name_unique ON items (name);
CREATE INDEX items_kind ON items (kind, active);

CREATE TABLE locations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('ambient', 'chill', 'freezer', 'production', 'dispatch')),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX locations_name_unique ON locations (name);

CREATE TABLE suppliers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX suppliers_name_unique ON suppliers (name);

CREATE TABLE customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX customers_name_unique ON customers (name);

CREATE TABLE staff (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX staff_name_unique ON staff (name);

-- The controlled conversions master. The old system read these live from a
-- spreadsheet owned by another system; trace owns them. One row per hop, so a
-- case of an item reaches its base unit through 'case' -> 'unit' -> base, and
-- every hop is stated rather than inferred.
CREATE TABLE unit_conversions (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES items (id),
  from_unit  TEXT NOT NULL,
  to_unit    TEXT NOT NULL,
  factor     REAL NOT NULL CHECK (factor > 0),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK (from_unit <> to_unit)
);

CREATE UNIQUE INDEX unit_conversions_hop_unique ON unit_conversions (item_id, from_unit, to_unit);
CREATE INDEX unit_conversions_item ON unit_conversions (item_id);
