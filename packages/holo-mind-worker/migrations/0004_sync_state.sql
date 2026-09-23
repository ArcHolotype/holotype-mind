-- Cursor store for the read-only x402 evidence scan, so a backfill resumes where it
-- stopped instead of re-scanning (and re-hitting RPC rate limits) every beat.
CREATE TABLE IF NOT EXISTS holo_sync_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
