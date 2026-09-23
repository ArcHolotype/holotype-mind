-- x402 settlement evidence: the Base tx hash of the USDC outflow that paid for this beat.
-- Filled read-only by scanning the wallet's on-chain Transfer logs (no signing involved).
ALTER TABLE holo_darkroom ADD COLUMN tx_hash TEXT;
