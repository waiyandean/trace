-- P1 — Receive: the ledger.
--
-- Three ideas hold this file together, and each of them is a decision from
-- PLAN.md rather than a schema convenience.
--
-- 1. A submission is an envelope. Every write to the ledger belongs to one
--    `events` row carrying the payload exactly as the device sent it and a
--    client-generated idempotency key. A resend of an accepted submission is
--    recognised and refused rather than written twice. The old system's 67
--    duplicate Goods Intake rows came from not having this.
--
-- 2. The ledger is append-only. `movements` are the only record of quantity
--    and location, and they may never be updated or deleted — triggers below
--    enforce that in the database rather than trusting every future caller.
--    A correction writes a compensating movement, never an edit.
--
-- 3. Identity is minted on the device. A lot's id is a ULID the iPad
--    generates, so intake works with no network at all. The six-character
--    short code that gets printed comes from a pool the server pre-issues to
--    that device, because uniqueness cannot be checked offline at the door.

-- One row per form submission.
CREATE TABLE events (
  id              TEXT PRIMARY KEY,

  -- Only 'receive' is written in P1. The rest are named now so that the
  -- constraint does not have to be relaxed later under time pressure, and so
  -- a reader can see the shape the ledger is growing into.
  kind            TEXT NOT NULL CHECK (kind IN (
                    'receive', 'move', 'waste', 'produce', 'dispatch', 'count', 'adjust'
                  )),

  -- What makes offline sync safe. Minted with the submission on the device
  -- and unchanged across every retry of it, so the second arrival of one
  -- submission is identifiable as the same submission.
  idempotency_key TEXT NOT NULL,

  -- A fingerprint of the payload this key was first accepted with. A retry
  -- carrying the same key but different content is a bug or a reused key, not
  -- a duplicate, and must be rejected loudly rather than silently ignored.
  payload_hash    TEXT NOT NULL,

  staff_id        TEXT NOT NULL REFERENCES staff (id),
  device_id       TEXT REFERENCES devices (id),

  -- Two clocks, deliberately. `occurred_at` is when the thing happened in the
  -- kitchen, as the device saw it; `recorded_at` is when the server accepted
  -- it. For a submission queued overnight offline these are days apart, and
  -- an auditor is entitled to see both.
  occurred_at     TEXT NOT NULL,
  recorded_at     TEXT NOT NULL DEFAULT (datetime('now')),

  -- The submission as received, verbatim JSON. Evidence, not working data:
  -- nothing reads it to decide anything. If the parsing above it is ever
  -- found wrong, this is what the ledger can be rebuilt from.
  payload         TEXT NOT NULL,

  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX events_idempotency_key_unique ON events (idempotency_key);
CREATE INDEX events_kind ON events (kind, occurred_at);

-- The devices that submit. Registered rather than free text, so a typo in a
-- device name cannot quietly mint a second short-code pool that then collides
-- with nothing and is discovered only when a label is unreadable.
CREATE TABLE devices (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX devices_name_unique ON devices (name);

-- A lot: one identifiable quantity of one item, from one delivery or one
-- production run.
--
-- Note what is NOT here: no quantity column and no location column. Both are
-- balances derived from `movements`, so neither can drift out of agreement
-- with the events beneath it. Part of a delivery routinely goes to the
-- freezer while the rest stays in chill, and a single location field on the
-- lot cannot represent that honestly.
CREATE TABLE lots (
  id             TEXT PRIMARY KEY,
  item_id        TEXT NOT NULL REFERENCES items (id),

  -- Printed on the label and typed by a human when a scan fails. Nullable on
  -- purpose: if a device's pool runs dry offline the lot is still created and
  -- still records the whole delivery, it simply has no printed code yet. That
  -- is a relabel, not lost data. Were this the primary key, an empty pool
  -- would stop intake at the door.
  short_code     TEXT REFERENCES short_codes (code),

  -- The batch number staff already read off the case today, kept exactly as
  -- it is. It is autofilled as the delivery date, so it does not identify a
  -- delivery uniquely — that is a property of the scheme, and it is why the
  -- system no longer joins on it. Nothing staff currently read disappears; it
  -- simply stops being load-bearing.
  batch_code     TEXT,

  origin         TEXT NOT NULL CHECK (origin IN ('received', 'produced', 'combined')),

  supplier_id    TEXT REFERENCES suppliers (id),
  supplier_lot   TEXT,
  supplier_invoice TEXT,

  -- When the lot came into being: delivered, or finished production.
  originated_at  TEXT NOT NULL,

  use_by         TEXT,

  -- Which source the use-by came from (PLAN.md open question 5). Without it
  -- neither question can be answered later: if a supplier's date proves
  -- wrong, which lots relied on it; and if seven days proves too generous,
  -- which lots were dated by the rule rather than by evidence.
  use_by_source  TEXT CHECK (use_by_source IN ('supplier_printed', 'shelf_life_rule')),

  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'closed', 'held', 'written_off')),

  event_id       TEXT NOT NULL REFERENCES events (id),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),

  -- A date with no stated source is a date that cannot be defended, so the
  -- two travel together or not at all.
  CHECK ((use_by IS NULL) = (use_by_source IS NULL)),

  -- A received lot must name where it came from; a produced one has no
  -- supplier, and its parentage lives in the movements that consumed its
  -- ingredients.
  CHECK (origin <> 'received' OR supplier_id IS NOT NULL)
);

CREATE UNIQUE INDEX lots_short_code_unique ON lots (short_code) WHERE short_code IS NOT NULL;
CREATE INDEX lots_item_status ON lots (item_id, status, use_by);
CREATE INDEX lots_event ON lots (event_id);
CREATE INDEX lots_batch_code ON lots (item_id, batch_code);

-- Append-only. Every change in quantity or location is a row here, and stock
-- on hand is their sum per lot per location.
CREATE TABLE movements (
  id                 TEXT PRIMARY KEY,
  lot_id             TEXT NOT NULL REFERENCES lots (id),

  type               TEXT NOT NULL CHECK (type IN (
                       'RECEIVE', 'MOVE', 'CONSUME', 'PRODUCE',
                       'WASTE', 'DISPATCH', 'ADJUST', 'COMBINE'
                     )),

  -- Signed, in the item's base unit. Positive brings stock in, negative takes
  -- it out; a MOVE is a negative row at the from-location and a positive row
  -- at the to-location, so the two sides can never be half-applied.
  quantity           REAL NOT NULL CHECK (quantity <> 0),

  -- What the person actually keyed, before conversion — "3 case", not "24 kg"
  -- — kept beside the converted figure. If a conversion factor is later found
  -- wrong, this is what says whether the entry or the factor was at fault.
  entered_quantity   REAL,
  entered_unit       TEXT,

  from_location_id   TEXT REFERENCES locations (id),
  to_location_id     TEXT REFERENCES locations (id),

  -- The genealogy edge: which other lot this movement fed into or came from.
  counterpart_lot_id TEXT REFERENCES lots (id),

  occurred_at        TEXT NOT NULL,
  recorded_at        TEXT NOT NULL DEFAULT (datetime('now')),
  staff_id           TEXT NOT NULL REFERENCES staff (id),

  reason             TEXT,
  note               TEXT,
  event_id           TEXT NOT NULL REFERENCES events (id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),

  -- Stock arriving must say where it landed; stock leaving must say where it
  -- left from. Otherwise a balance per location cannot be computed.
  CHECK (quantity < 0 OR to_location_id IS NOT NULL),
  CHECK (quantity > 0 OR from_location_id IS NOT NULL)
);

CREATE INDEX movements_lot ON movements (lot_id, occurred_at);
CREATE INDEX movements_event ON movements (event_id);
CREATE INDEX movements_location ON movements (to_location_id, from_location_id);

-- Append-only enforced here rather than by convention. A correction is a
-- compensating movement plus an amendment row; it is never an edit, and the
-- database is where that should be true even for a future caller that has
-- forgotten the rule.
CREATE TRIGGER movements_no_update
BEFORE UPDATE ON movements
BEGIN
  SELECT RAISE(ABORT, 'movements are append-only: write a compensating movement');
END;

CREATE TRIGGER movements_no_delete
BEFORE DELETE ON movements
BEGIN
  SELECT RAISE(ABORT, 'movements are append-only: write a compensating movement');
END;

-- The short-code pool (PLAN.md open question 2, resolved 2026-08-28).
--
-- The server reserves codes to one device at a time, so two devices cannot
-- mint the same code while both are offline. A code is bound to at most one
-- lot, ever, and is never returned to the pool: a reused code on a box would
-- point at two different deliveries, which is the exact failure this system
-- exists to remove.
CREATE TABLE short_codes (
  code       TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL REFERENCES devices (id),
  issued_at  TEXT NOT NULL DEFAULT (datetime('now')),

  -- Null until intake pops this code and binds it.
  lot_id     TEXT REFERENCES lots (id),
  bound_at   TEXT,

  CHECK (length(code) = 6),
  CHECK ((lot_id IS NULL) = (bound_at IS NULL))
);

CREATE UNIQUE INDEX short_codes_lot_unique ON short_codes (lot_id) WHERE lot_id IS NOT NULL;

-- Refilling a pool asks "which codes does this device still hold unbound",
-- so that is the index.
CREATE INDEX short_codes_unbound ON short_codes (device_id) WHERE lot_id IS NULL;
