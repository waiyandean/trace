-- P1 — which supplier a given ingredient comes from.
--
-- The intake form asks for the supplier first, so it can then show only that
-- supplier's ingredients rather than the whole catalog. At the goods-in door
-- that turns sixty-odd tiles into twenty-odd, which is the difference between
-- scanning a grid and hunting through one.
--
-- The relationship is many-to-many even though the kitchen mostly buys one
-- ingredient from one supplier. That is not hedging: the kitchen's own
-- records show several items arriving from both Lynas and Tazaki, and its
-- maintained supplier list marks three of them as belonging to both. A
-- one-supplier-per-item column could not hold that without deciding, on no
-- evidence, which of the two to discard.
CREATE TABLE item_suppliers (
  item_id     TEXT NOT NULL REFERENCES items (id),
  supplier_id TEXT NOT NULL REFERENCES suppliers (id),

  -- Where this pairing came from, so a wrong one can be traced back rather
  -- than argued about: 'registered' is the kitchen's maintained supplier
  -- list, 'delivered' is the fact that this supplier has actually delivered
  -- this item, and 'decided' is a person saying so directly.
  source      TEXT NOT NULL CHECK (source IN ('registered', 'delivered', 'decided')),

  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (item_id, supplier_id)
);

CREATE INDEX item_suppliers_supplier ON item_suppliers (supplier_id);
