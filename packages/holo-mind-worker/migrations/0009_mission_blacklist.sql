-- Blacklist for mission counterparties that submitted an injection-shaped delivery.
-- Keyed on the lowercased claimant string and/or the payout address; checked before an
-- autonomous acceptance runs and appended when the delivery scanner refuses a submission.
-- Best-effort containment only: a counterparty can rotate to a fresh claimant/address, so
-- this stops a repeat offender, not a one-off attempt. The hard bound on loss stays the
-- code-enforced per-mission / per-day reward caps.
CREATE TABLE IF NOT EXISTS holo_mission_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bkey TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  reason TEXT,
  ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mission_blacklist_bkey ON holo_mission_blacklist (bkey);
