-- First schema of the waitlist (later changed by 0002_email.sql).
-- Waitlist (consented contact handles) and the short-lived rate-limit log.
-- handle_norm is "tg:<name>" or "x:<name>" (lowercase, no @); a duplicate insert is ignored by the handler.
CREATE TABLE IF NOT EXISTS waitlist (
  handle_norm     TEXT    NOT NULL UNIQUE,
  channel         TEXT    NOT NULL CHECK (channel IN ('telegram', 'x')),
  consent_version TEXT    NOT NULL,
  jurisdiction_ok INTEGER NOT NULL CHECK (jurisdiction_ok = 1),
  created_at      INTEGER NOT NULL -- unix seconds
);

-- One row per POST /api/join: salted SHA-256 of the client IP, never the IP. Rows older than 24 h are deleted
-- by the handler on every request.
CREATE TABLE IF NOT EXISTS join_attempts (
  ip_hash    TEXT    NOT NULL,
  created_at INTEGER NOT NULL -- unix seconds
);
CREATE INDEX IF NOT EXISTS join_attempts_ip_time ON join_attempts (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS join_attempts_time ON join_attempts (created_at);
