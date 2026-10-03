-- Waitlist v3 (2026-10-03): email is required for new signups and is the unique key; a Telegram username and an
-- X handle are each optional, and a signup may give both. (Revised in place on 2026-10-03, before 0002 was ever
-- deployed: the first draft had one optional handle + channel pair.)
-- SQLite cannot drop a NOT NULL or UNIQUE constraint in place, so the table is rebuilt and the rows from 0001
-- are copied over unchanged (they have a handle_norm + channel and no email).
--   email        normalised address (trimmed, lowercased; dots and +tags kept), stored in plain text because the
--                launch notice is sent to it. NULL only on rows from before this migration.
--   telegram     Telegram username, lowercase, no @ (5-32 of a-z 0-9 _, letter first), or NULL.
--   x            X handle, lowercase, no @ (1-15 of a-z 0-9 _), or NULL.
--   handle_norm, channel   rows from 0001 only ("tg:<name>" / "x:<name>"); new rows leave them NULL.
CREATE TABLE waitlist_new (
  email           TEXT    UNIQUE CHECK (email IS NULL OR length(email) <= 254),
  telegram        TEXT    CHECK (telegram IS NULL OR length(telegram) BETWEEN 5 AND 32),
  x               TEXT    CHECK (x IS NULL OR length(x) BETWEEN 1 AND 15),
  handle_norm     TEXT,
  channel         TEXT    CHECK (channel IS NULL OR channel IN ('telegram', 'x')),
  consent_version TEXT    NOT NULL,
  jurisdiction_ok INTEGER NOT NULL CHECK (jurisdiction_ok = 1),
  created_at      INTEGER NOT NULL, -- unix seconds
  CHECK (email IS NOT NULL OR handle_norm IS NOT NULL),
  CHECK ((handle_norm IS NULL) = (channel IS NULL))
);

INSERT INTO waitlist_new (email, telegram, x, handle_norm, channel, consent_version, jurisdiction_ok, created_at)
  SELECT NULL, NULL, NULL, handle_norm, channel, consent_version, jurisdiction_ok, created_at FROM waitlist;

DROP TABLE waitlist;
ALTER TABLE waitlist_new RENAME TO waitlist;
