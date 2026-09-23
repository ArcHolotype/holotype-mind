-- Nectar missions: published tasks, claims, deliveries, creator approvals and the
-- on-chain settlement tx. This table alone never moves money: a payment additionally
-- requires a fresh approval JSON plus the separate payment rail, both fail-closed.
CREATE TABLE IF NOT EXISTS holo_missions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  criteria      TEXT NOT NULL,            -- JSON array of strings ("what counts as done")
  reward_cents  INTEGER NOT NULL,         -- USD cents reserved for a accepted delivery
  chain         TEXT NOT NULL DEFAULT 'arc',
  status        TEXT NOT NULL DEFAULT 'open',  -- open|claimed|submitted|approval_pending|approved|completed|returned|cancelled
  claimant      TEXT,                     -- agent/address that claimed; NULL while open
  delivery      TEXT,                     -- JSON {summary,artifact,recipient,evidence,taskHash,submittedAt}
  approval      TEXT,                     -- JSON {by,at,amountCents,recipient,nonce}; MUST exist before pay
  tx_hash       TEXT,                     -- on-chain settlement tx once paid
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holo_missions_status ON holo_missions(status);
CREATE INDEX IF NOT EXISTS idx_holo_missions_ts ON holo_missions(ts);
