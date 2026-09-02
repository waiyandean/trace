-- P3 — the batch's own facts, and what it packed out to.
--
-- A batch is a lot plus an event, which carries the genealogy perfectly well
-- and has nowhere to put the things that are true of the making rather than
-- of the stock: was the equipment checked, was this a double batch, how many
-- packets came out, were they labelled.
--
-- Packets produced is not bookkeeping. It is the output side of a mass
-- balance: what went in against what came out, which is how the kitchen sees
-- that every ingredient is accounted for (Dean, 2026-09-02). A batch that
-- consumed 60 kg and packed 12 kg has either lost something or recorded
-- something wrongly, and both are worth knowing.
CREATE TABLE batch_records (
  lot_id            TEXT PRIMARY KEY REFERENCES lots (id),
  event_id          TEXT NOT NULL REFERENCES events (id),
  recipe_id         TEXT REFERENCES recipes (id),

  -- A double batch is the recipe twice over, so the expected quantities are
  -- the recipe's multiplied. Recorded rather than inferred from what was
  -- used, because inferring it would make every yield comparison circular.
  multiplier        REAL NOT NULL DEFAULT 1 CHECK (multiplier > 0),

  -- Confirmed before starting, as the current form asks.
  equipment_checked INTEGER NOT NULL CHECK (equipment_checked IN (0, 1)),

  -- What came out, in the product's base unit. Empty until it is packed:
  -- how much a batch made is not known while it is cooking, and a form that
  -- asked for it then would be asking somebody to type a number before it
  -- existed.
  yield_quantity    REAL CHECK (yield_quantity > 0),

  -- Packing happens after the batch, sometimes by somebody else, so these
  -- start empty and are filled in then. Null means not packed yet, which is
  -- different from packed and yielding nothing.
  packets_produced  INTEGER CHECK (packets_produced >= 0),
  label_check       INTEGER CHECK (label_check IN (0, 1)),
  packed_at         TEXT,
  packed_by         TEXT REFERENCES staff (id),
  packed_event      TEXT REFERENCES events (id),

  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),

  -- Packed means all four, or none of them.
  CHECK ((packets_produced IS NULL) = (packed_at IS NULL)),
  CHECK ((packed_at IS NULL) = (packed_by IS NULL))
);

CREATE INDEX batch_records_unpacked ON batch_records (packed_at, created_at);
