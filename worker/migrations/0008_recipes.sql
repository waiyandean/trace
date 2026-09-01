-- P3 — Produce: what a product is made from.
--
-- Recipes are reference data the kitchen maintains, like the catalog: they
-- say what a batch of a product is supposed to contain, and how long the
-- result keeps. They are not the record of what a batch actually contained —
-- that is movements, and the difference between the two is the yield.
--
-- Ingredients and products share the items table, so a recipe line pointing
-- at a product needs no special case. Ten of the kitchen's recipe lines
-- already do: the frozen ramen lines are built from soups, which are
-- themselves built from broths.
CREATE TABLE recipes (
  id            TEXT PRIMARY KEY,

  -- The product this makes. One recipe per product for now; the column is
  -- unique rather than the table assuming it, so a second version of a recipe
  -- becomes a visible decision rather than a silent duplicate.
  item_id       TEXT NOT NULL REFERENCES items (id),

  -- What one batch of this recipe yields, in the product's base unit. Null
  -- where nobody has stated it: the kitchen's recipes give ingredient
  -- quantities but not always an expected output, and inventing one would
  -- make every yield comparison meaningless.
  yield_quantity REAL CHECK (yield_quantity > 0),

  -- How long the finished product keeps, from the day it was produced. The
  -- kitchen states this in months; it is stored in days so that a use-by is
  -- arithmetic rather than calendar guesswork.
  shelf_life_days INTEGER CHECK (shelf_life_days > 0),

  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX recipes_item_unique ON recipes (item_id);

-- One line per ingredient a batch is supposed to use.
CREATE TABLE recipe_lines (
  id          TEXT PRIMARY KEY,
  recipe_id   TEXT NOT NULL REFERENCES recipes (id),
  item_id     TEXT NOT NULL REFERENCES items (id),

  -- The target, in the unit the kitchen states it in — which is the unit the
  -- recipe card uses, not necessarily the item's base unit. The conversions
  -- master turns one into the other, and keeping the stated unit means a
  -- recipe reads on screen the way it reads on the wall.
  quantity    REAL NOT NULL CHECK (quantity > 0),
  unit        TEXT NOT NULL,

  sort_order  INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX recipe_lines_unique ON recipe_lines (recipe_id, item_id);
CREATE INDEX recipe_lines_recipe ON recipe_lines (recipe_id, sort_order);
CREATE INDEX recipe_lines_item ON recipe_lines (item_id);
