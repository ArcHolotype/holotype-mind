-- Holo's reading material + its speaking schedule.
--
-- WHY THESE EXIST. The broadcast rail used to post every N hours from a fixed interval and
-- drew its material only from Holo's own recent inner monologue, so the public voice had a
-- narrow well to drink from. Two changes, both code-enforced rather than model-trusted:
--
--   holo_x_corpus   — vetted excerpts about Drosophila neuroscience, fetched on a slow cron
--                     from a fixed whitelist of public science APIs. The posting path NEVER
--                     fetches the network: it reads only from this table. Every row records
--                     where it came from, so any post can be traced back to the exact text
--                     Holo was reading when it wrote it. Rows are rejected at ingest if they
--                     carry links, key-shaped hex, other tokens, or instruction-like phrasing,
--                     so untrusted web text is filtered before it can ever reach the model.
--                     Repetition is bounded by data, not by hoping: `used_at` drives a cooldown
--                     and `topic` drives a once-per-day topic budget.
--
--   holo_x_schedule — one row holding when the next self-post becomes eligible. The gap is
--                     drawn at random after each post so the timing looks like an organism's
--                     own rhythm rather than a metronome, while the daily floor is recovered
--                     by shortening the gap whenever the day falls behind pace.
--
-- Counts of what was actually sent are NOT stored here: holo_x_posts stays the single source
-- of truth, because a counter that can drift from the log is how the rail once mistook a
-- published post for a failed one.

CREATE TABLE IF NOT EXISTS holo_x_corpus (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  topic         TEXT NOT NULL,               -- code-assigned from the query that found it, never model-reported
  source        TEXT NOT NULL,               -- europepmc | wikipedia | plos | elife | openalex | custom
  source_url    TEXT NOT NULL,               -- where the excerpt came from; kept for traceability
  title         TEXT NOT NULL,               -- article/page title, cleaned
  excerpt       TEXT NOT NULL,               -- the vetted prose Holo is allowed to read
  content_hash  TEXT NOT NULL UNIQUE,        -- sha256(excerpt); the same text is never ingested twice
  used_at       TEXT,                        -- last time a SENT post drew on it; NULL = never used
  used_count    INTEGER NOT NULL DEFAULT 0,
  ingested_at   TEXT NOT NULL
);
-- The pick query filters on topic + used_at and orders by least-recently-used.
CREATE INDEX IF NOT EXISTS idx_x_corpus_pick ON holo_x_corpus(topic, used_at);
CREATE INDEX IF NOT EXISTS idx_x_corpus_hash ON holo_x_corpus(content_hash);

CREATE TABLE IF NOT EXISTS holo_x_schedule (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  next_eligible_at   TEXT NOT NULL,          -- the next self-post may not fire before this
  last_gap_minutes   INTEGER,                -- the random gap drawn after the previous post
  updated_at         TEXT NOT NULL
);
INSERT OR IGNORE INTO holo_x_schedule (id, next_eligible_at, last_gap_minutes, updated_at)
VALUES (1, '1970-01-01T00:00:00.000Z', NULL, '1970-01-01T00:00:00.000Z');

-- Which reading and which framing produced a given post, so the audit trail answers
-- "what was it looking at when it said that?" without guessing.
ALTER TABLE holo_x_posts ADD COLUMN corpus_id INTEGER;
ALTER TABLE holo_x_posts ADD COLUMN angle TEXT;

-- Daily caps are counted per trigger and per day; without this the count scans the whole
-- table on every tick, and the table grows by ~20 rows a day forever.
CREATE INDEX IF NOT EXISTS idx_x_posts_trigger_day ON holo_x_posts(trigger, status, posted_at);
CREATE INDEX IF NOT EXISTS idx_x_posts_status_day ON holo_x_posts(status, posted_at);
