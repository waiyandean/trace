-- P3 — short codes for produced lots, minted at pack time.
--
-- Goods In's codes come from a pool pre-issued to a device, because a device
-- at the door has to print a label before it can reach the server at all
-- (codes.js, PLAN.md "Lot identity and short codes"). Batching has no such
-- requirement — it is explicitly online-only (PLAN.md, "Where the iPad
-- actually is") — so there is no offline moment a produced lot's code has to
-- exist before the server can be asked for one. `recordPacking` mints and
-- binds a code directly, in the same statement that packs the batch out,
-- with nothing pre-reserved and no device involved.
--
-- short_codes.device_id was NOT NULL, which this rebuild relaxes: a
-- pack-time code has no device to attribute it to. SQLite cannot ALTER a
-- column's NOT NULL, so the table is rebuilt rather than altered in place —
-- nothing has been deployed to the remote database yet (PLAN.md: the live
-- Worker is still the P0 read-only build), so there is no production data
-- this could lose.
CREATE TABLE short_codes_new (
  code       TEXT PRIMARY KEY,
  device_id  TEXT REFERENCES devices (id),
  issued_at  TEXT NOT NULL DEFAULT (datetime('now')),
  lot_id     TEXT REFERENCES lots (id),
  bound_at   TEXT,

  CHECK (length(code) = 6),
  CHECK ((lot_id IS NULL) = (bound_at IS NULL)),
  -- A device-less code with nothing bound to it is not a real state: only a
  -- device's own pool holds unbound codes. A pack-time code is minted and
  -- bound in the same breath, never left waiting.
  CHECK (device_id IS NOT NULL OR lot_id IS NOT NULL)
);

INSERT INTO short_codes_new (code, device_id, issued_at, lot_id, bound_at)
  SELECT code, device_id, issued_at, lot_id, bound_at FROM short_codes;

DROP TABLE short_codes;
ALTER TABLE short_codes_new RENAME TO short_codes;

CREATE UNIQUE INDEX short_codes_lot_unique ON short_codes (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX short_codes_unbound ON short_codes (device_id) WHERE lot_id IS NULL;
