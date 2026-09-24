-- x402 buyer purchases: the persistent state that makes the two money-safety constraints
-- survive across stateless Worker requests. One row per purchase intent (purchase_key), locking
-- the EXACT EIP-3009 authorization that was prepared and approved (including its single-use
-- nonce). This table never moves money by itself: signing additionally requires status=approved
-- with a matching approval JSON, an atomic approved->in_flight claim, and the separate buyer rail.
CREATE TABLE IF NOT EXISTS holo_x402_purchases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_key  TEXT NOT NULL UNIQUE,       -- idempotency key (e.g. mission id); one live purchase per key
  network       TEXT NOT NULL,              -- CAIP-2, e.g. eip155:5042 (Arc) / eip155:8453 (Base)
  asset         TEXT NOT NULL,              -- verified USDC contract the authorization transfers
  pay_to        TEXT NOT NULL,              -- seller payout address (locked into the signature)
  amount        TEXT NOT NULL,              -- atomic USDC units, decimal string (locked into the signature)
  nonce         TEXT NOT NULL,              -- EIP-3009 bytes32, single-use on-chain (locked into the signature)
  valid_after   INTEGER NOT NULL,           -- unix seconds
  valid_before  INTEGER NOT NULL,           -- unix seconds; after this the auth can no longer settle
  resource_url  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'prepared', -- prepared|approved|in_flight|settled|failed|uncertain
  approval      TEXT,                       -- JSON {by,at}; MUST be present (status approved) before signing
  payer         TEXT,                       -- Holo wallet that signed (= authorization.from)
  tx_hash       TEXT,                       -- on-chain settlement tx once settled (from receipt or reconcile)
  receipt       TEXT,                       -- JSON settlement response from the seller's facilitator
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_x402_purchases_status ON holo_x402_purchases(status);
CREATE INDEX IF NOT EXISTS idx_x402_purchases_nonce ON holo_x402_purchases(nonce);
