// x402 settlement evidence: link each recorded beat to the on-chain Base tx that paid
// for it. The LLM client does not surface the chat payment's tx hash, so we recover it
// read-only: every beat is exactly one USDC Transfer outflow from the Holo wallet, and
// the wallet has no other outflows, so we scan Transfer logs and match each pending beat
// by amount + block timestamp. No signing, no spending — pure reads.
//
// The scan is rate-limit friendly: a persisted cursor (holo_sync_state) means each beat
// resumes where the last stopped instead of re-scanning, calls retry with backoff on
// 429, and a per-run page budget spreads any large backfill across several beats.

import { readConfig, type Env } from "./config.js";
import {
  readLatestBlock,
  readUsdcOutflowWindow,
  readBlockTimestamp,
  withRpcFallback,
  type UsdcOutflow,
} from "./rpc.js";
import { unhashedBeats, setTxHash, getSyncState, setSyncState } from "./store.js";

const PAGE_BLOCKS = 1000; // public RPCs cap eth_getLogs ranges at 1000 blocks
const UP_PAGES_PER_RUN = 2; // fresh blocks since the last run (catches new beats)
const DOWN_PAGES_PER_RUN = 3; // backfill budget walking toward genesis
const PAGE_DELAY_MS = 500;
const TIME_TOLERANCE_S = 600; // settlement lands seconds after the beat; generous margin
const HIGH_KEY = "txhash_high_block"; // newest block already scanned
const CURSOR_KEY = "txhash_cursor_block"; // deepest block still to scan (backfill)
// The scan is pure public reads. Worker egress gets rate-limited by any single provider,
// so spread across several free endpoints (each 429 falls through to the next) and keep
// the metered keys as last resort.
const PUBLIC_SCAN_RPC = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.llamarpc.com"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry only rate-limit failures; anything else propagates immediately.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!/429|rate|limit/i.test((e as Error).message)) throw e;
      await sleep(3000 * (attempt + 1));
    }
  }
  throw lastErr;
}

interface Pending {
  id: number;
  ts: string;
  cost_usd: number | null;
  tx_hash: string | null;
}

export async function syncTxHashes(env: Env): Promise<number> {
  const cfg = readConfig(env);
  const urls = [...PUBLIC_SCAN_RPC, ...cfg.baseRpcUrls];
  const pending: Pending[] = await unhashedBeats(env.DB);
  if (pending.length === 0) return 0;

  const latest = await withRetry(() => withRpcFallback(urls, (u) => readLatestBlock(u)));
  const highRaw = await getSyncState(env.DB, HIGH_KEY);
  const lowRaw = await getSyncState(env.DB, CURSOR_KEY);
  let high = highRaw && highRaw !== "" ? Number(highRaw) : latest;
  let low = lowRaw && lowRaw !== "" ? Number(lowRaw) : latest;
  let attached = 0;

  const matchWindow = async (from: number, to: number) => {
    const window: UsdcOutflow[] = await withRetry(() =>
      withRpcFallback(urls, (u) => readUsdcOutflowWindow(u, cfg.publicWallet, from, to)),
    );
    const tsByBlock = new Map<number, number>();
    for (const o of window) {
      if (!tsByBlock.has(o.blockNumber)) {
        tsByBlock.set(
          o.blockNumber,
          await withRetry(() => withRpcFallback(urls, (u) => readBlockTimestamp(u, o.blockNumber))),
        );
      }
    }
    for (const o of window) {
      const blockTs = tsByBlock.get(o.blockNumber) ?? 0;
      const hit = pending.find((b) => {
        if (b.tx_hash) return false;
        const beatTs = Date.parse(b.ts) / 1000;
        if (!Number.isFinite(beatTs) || Math.abs(blockTs - beatTs) > TIME_TOLERANCE_S) return false;
        const cost = b.cost_usd ?? 0;
        return Math.abs(o.valueUnits - cost) <= Math.max(1e-6, cost * 0.05);
      });
      if (hit) {
        await setTxHash(env.DB, hit.id, o.txHash);
        hit.tx_hash = o.txHash;
        attached++;
      }
    }
  };

  // Upward: blocks newer than the last run's high-water mark (the new beats).
  let end = latest;
  for (let page = 0; page < UP_PAGES_PER_RUN && end > high; page++) {
    const from = Math.max(high + 1, end - PAGE_BLOCKS + 1);
    await matchWindow(from, end);
    end = from - 1;
    await sleep(PAGE_DELAY_MS);
  }
  await setSyncState(env.DB, HIGH_KEY, String(latest));

  // Downward: backfill toward genesis for beats older than the cursor.
  end = Math.min(low, latest);
  for (let page = 0; page < DOWN_PAGES_PER_RUN && attached < pending.length; page++) {
    const from = Math.max(0, end - PAGE_BLOCKS + 1);
    await matchWindow(from, end);
    const next = from - 1;
    await setSyncState(env.DB, CURSOR_KEY, next > 0 ? String(next) : "");
    if (next <= 0) break;
    end = next;
    await sleep(PAGE_DELAY_MS);
  }
  return attached;
}
