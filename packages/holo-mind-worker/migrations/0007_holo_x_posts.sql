-- X (Twitter) self-broadcast log: one row per post/reply Holo puts on its own account.
-- This table is the memory that makes the broadcast rail's code-enforced guards survive
-- across stateless Worker requests: the every-3h cadence + per-day caps are counted from
-- posted_at, and the no-repeat rule dedups a candidate against recent text here. It records
-- what was SENT (or DROPPED by the gate) so every public post is auditable. It never moves
-- money and holds no key: posting goes through OpenTweet with the ot_ secret, and the
-- speaking path is isolated from the wallet signing path.
CREATE TABLE IF NOT EXISTS holo_x_posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,              -- post | reply
  text          TEXT NOT NULL,              -- the exact public text that was sent
  dedup_hash    TEXT NOT NULL,              -- stable hash of normalized text, for the no-repeat gate
  ref           TEXT,                       -- optional context ref (e.g. mission-<id>, tx:<hash>)
  trigger       TEXT,                       -- what caused it: publish | settlement | cadence | reply
  status        TEXT NOT NULL DEFAULT 'sent', -- sent | dropped | failed
  gate_reason   TEXT,                       -- when dropped/failed, which gate refused it
  opentweet_id  TEXT,                       -- id returned by OpenTweet for the created post
  in_reply_to   TEXT,                       -- for kind=reply, the tweet id being replied to
  posted_at     TEXT NOT NULL               -- ISO timestamp; cadence + per-day caps count from this
);
CREATE INDEX IF NOT EXISTS idx_x_posts_posted_at ON holo_x_posts(posted_at);
CREATE INDEX IF NOT EXISTS idx_x_posts_kind ON holo_x_posts(kind);
CREATE INDEX IF NOT EXISTS idx_x_posts_dedup ON holo_x_posts(dedup_hash);
