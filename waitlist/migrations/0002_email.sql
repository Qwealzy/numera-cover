-- Waitlist v3 (2026-10-03): email is required for new signups and is the unique key; the Telegram/X handle is
-- optional. SQLite cannot drop a NOT NULL or UNIQUE constraint in place, so the table is rebuilt and the rows
-- from 0001 are copied over unchanged (they have a handle and no email).
--   email        normalised address (trimmed, lowercased; dots and +tags kept), stored in plain text because the
--                launch notice is sent to it. NULL only on rows from before this migration.
--   handle_norm  "tg:<name>" or "x:<name>", or NULL when no handle was given. No longer unique: two people may
--                not share an email, but a handle given with a new email must not make that signup vanish.
CREATE TABLE waitlist_new (
  email           TEXT    UNIQUE CHECK (email IS NULL OR length(email) <= 254),
  handle_norm     TEXT,
  channel         TEXT    CHECK (channel IS NULL OR channel IN ('telegram', 'x')),
  consent_version TEXT    NOT NULL,
  jurisdiction_ok INTEGER NOT NULL CHECK (jurisdiction_ok = 1),
  created_at      INTEGER NOT NULL, -- unix seconds
  CHECK (email IS NOT NULL OR handle_norm IS NOT NULL),
  CHECK ((handle_norm IS NULL) = (channel IS NULL))
);

INSERT INTO waitlist_new (email, handle_norm, channel, consent_version, jurisdiction_ok, created_at)
  SELECT NULL, handle_norm, channel, consent_version, jurisdiction_ok, created_at FROM waitlist;

DROP TABLE waitlist;
ALTER TABLE waitlist_new RENAME TO waitlist;

CREATE INDEX IF NOT EXISTS waitlist_handle ON waitlist (handle_norm);
