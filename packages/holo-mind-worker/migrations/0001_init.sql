-- Holotype MIND worker — isolated D1 schema.
-- This database is the MIND's own store. It is NOT the body's holotype-db and NOT
-- upstream murmur-db. Two tables, both private:
--   holo_darkroom        Holo's inner log: narration + intent + policy verdict + cost.
--   holo_private_memory  the creator<->Holo channel, ENCRYPTED at rest (ciphertext only).

CREATE TABLE IF NOT EXISTS holo_darkroom (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,
  tick_index      INTEGER,
  temperature     REAL,
  regime          TEXT,
  arousal         REAL,
  valence         REAL,
  behavior        TEXT,
  fap             TEXT,
  model           TEXT,
  narration       TEXT    NOT NULL,
  intent_json     TEXT,
  policy_decision TEXT,
  policy_reason   TEXT,
  prompt_tokens   INTEGER,
  completion_tokens INTEGER,
  cost_usd        REAL
);

-- Index for the daily-budget sum (WHERE ts LIKE '<day>%') and recent reads.
CREATE INDEX IF NOT EXISTS idx_darkroom_ts ON holo_darkroom (ts);

-- The creator<->Holo private channel. There is NO plaintext column: `ciphertext`
-- holds an AES-256-GCM blob (hex(iv).hex(ct+tag)). Decryption happens in-process
-- only, with HOLO_MASTER_KEY, only in the creator route and the heartbeat.
CREATE TABLE IF NOT EXISTS holo_private_memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  role       TEXT NOT NULL,            -- 'creator' | 'holo'
  ciphertext TEXT NOT NULL             -- AES-GCM blob; NEVER plaintext
);
