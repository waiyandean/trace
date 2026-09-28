-- A PIN alone can now sign somebody in (PLAN.md, open question 9): the person
-- types their PIN with nobody chosen yet, and the server works out who it
-- belongs to by checking it against everyone's. `staff_pins` already locks
-- one person out after repeated wrong guesses against *their* row, but a
-- blind guess before anyone is chosen does not belong to a row yet -- there
-- is nobody to charge it against. Left unchecked that would turn ten separate
-- 10,000-PIN locks into one shared 10,000-PIN keyspace with no lock on it at
-- all, since an attacker trying to identify *anybody* correctly is
-- attempting the whole kitchen's keyspace at once, not one person's.
--
-- This is that lock: one row, for guesses that matched nobody, entirely
-- separate from any person's own lockout. It only ever throttles blind
-- guessing -- choosing a name and entering that person's PIN is the original
-- flow (`checkPin` in src/auth.js) and is never affected by this row, which
-- is what keeps this a fallback layer rather than a second way to be locked
-- out of your own account.

CREATE TABLE identify_lockout (
  id           TEXT PRIMARY KEY DEFAULT 'identify',
  failed_count INTEGER NOT NULL DEFAULT 0,
  lock_level   INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

INSERT INTO identify_lockout (id) VALUES ('identify');
