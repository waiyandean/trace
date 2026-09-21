-- Authentication: who is recording (PLAN.md, open question 9).
--
-- Until now every form sent a `staff_id` chosen from a dropdown and the
-- server believed it, so anyone who could reach the API could record
-- anything as anyone. This holds one PIN per person so the server can work
-- out who is signing in instead of being told.
--
-- The PIN itself is never stored, and neither is anything that could be
-- attacked offline from a copy of this table. There are only 10,000 four-digit
-- PINs, so a plain hash of one is cracked instantly; `pin_hash` is instead an
-- HMAC keyed with a secret that lives in the Worker's secrets (PIN_PEPPER),
-- not in this database, with a per-row salt. A copy of the database alone
-- reveals nothing.
--
-- The small keyspace is what `failed_count`, `lock_level` and `locked_until`
-- are for: five wrong tries lock the person out for ten minutes, doubling on
-- every repeat, so guessing is limited by the clock rather than by 10,000.
--
-- A row is absent until somebody sets a PIN, and a person with no row cannot
-- sign in. Deliberately not a column on `staff`: the catalog is read by
-- public endpoints, and a credential should never sit beside a name in a
-- table that is served.

CREATE TABLE staff_pins (
  staff_id     TEXT PRIMARY KEY REFERENCES staff (id),

  pin_hash     TEXT NOT NULL,
  salt         TEXT NOT NULL,

  failed_count INTEGER NOT NULL DEFAULT 0,
  lock_level   INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,

  set_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
