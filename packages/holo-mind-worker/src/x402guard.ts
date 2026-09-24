// D1-backed BuyGuard + on-chain reconciliation for the x402 buyer rail (x402.ts). This is the
// persistence that makes the two money-safety constraints survive across stateless Worker
// requests, mirroring the pattern the vanilla payout rail already uses (payment_uncertain +
// reconcileMission). It never signs and never broadcasts: it only records state and, for an
// ambiguous outcome, READS the chain to decide whether the signed authorization was settled.
//
// Money-safety invariants enforced here:
//   ① approve() releases a signature only when the authorization matches, field for field
//      (network/asset/payTo/amount/nonce/validity window/payer), a row the creator approved.
//   ② begin() flips approved -> in_flight atomically, so exactly one caller can ever sign a
//      given purchase_key; a retry cannot mint a second authorization (no double-pay).
//   record() parks any non-success outcome as 'uncertain' (never silently 'failed'): a signed
//   authorization the seller holds can still settle until valid_before, so reconcile() only
//   declares 'failed' once the authorization has expired AND no on-chain settlement is found.

import type { RuntimeConfig } from "./config.js";
import { rpcCall, withRpcFallback, hexToUint } from "./rpc.js";
import { ARC_MAINNET, BASE_MAINNET, type BuyGuard, type Eip3009Authorization, type SettlementResponse } from "./x402.js";

export interface X402PurchaseRow {
  id: number;
  purchase_key: string;
  network: string;
  asset: string;
  pay_to: string;
  amount: string;
  nonce: string;
  valid_after: number;
  valid_before: number;
  resource_url: string;
  status: string;
  approval: string | null;
  payer: string | null;
  tx_hash: string | null;
  receipt: string | null;
  created_at: string;
  updated_at: string;
}

const nowIso = () => new Date().toISOString();
const pad32 = (addr: string): string => "0x" + addr.toLowerCase().replace("0x", "").padStart(64, "0");

// USDC emits AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce) when an
// EIP-3009 authorization is consumed. topic0 = keccak256 of that signature (verified via viem
// toEventSelector). Matching on authorizer+nonce pinpoints the exact authorization, so reconcile
// is precise — it does not rely on amount/recipient heuristics.
export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

export async function preparePurchase(
  db: D1Database,
  p: { purchaseKey: string; network: string; asset: string; resourceUrl: string; payer: string; auth: Eip3009Authorization },
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO holo_x402_purchases
         (purchase_key, network, asset, pay_to, amount, nonce, valid_after, valid_before,
          resource_url, status, payer, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'prepared',?10,?11,?12)`,
    )
    .bind(
      p.purchaseKey,
      p.network,
      p.asset,
      p.auth.to,
      p.auth.value,
      p.auth.nonce,
      Number(p.auth.validAfter),
      Number(p.auth.validBefore),
      p.resourceUrl,
      p.payer,
      nowIso(),
      nowIso(),
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

export async function getPurchaseByKey(db: D1Database, purchaseKey: string): Promise<X402PurchaseRow | null> {
  return (
    (await db.prepare(`SELECT * FROM holo_x402_purchases WHERE purchase_key = ?1`).bind(purchaseKey).first<X402PurchaseRow>()) ??
    null
  );
}

// Purchases created today that have COMMITTED to paying (approved or beyond) — backs the
// code-enforced x402 daily cap. A 'prepared' row (card created, not yet paid) and a 'failed'
// row (expired unsettled, safe to re-prepare) do NOT count against the cap; only money that
// is actually on its way out the door does.
export async function countX402CommittedToday(db: D1Database, dayPrefix: string): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM holo_x402_purchases
       WHERE created_at LIKE ?1 AND status IN ('approved','in_flight','settled','uncertain')`,
    )
    .bind(`${dayPrefix}%`)
    .first<{ c: number }>();
  return Number(r?.c ?? 0);
}

// Recent purchases (newest first) for the creator console. Read-only.
export async function listX402Purchases(db: D1Database, limit = 50): Promise<X402PurchaseRow[]> {
  const n = Math.min(200, Math.max(1, limit));
  const { results } = await db
    .prepare(`SELECT * FROM holo_x402_purchases ORDER BY id DESC LIMIT ?1`)
    .bind(n)
    .all<X402PurchaseRow>();
  return results ?? [];
}

// Delete a purchase row that reconcile already marked 'failed' (its authorization expired
// unsettled, so no money moved and none can). This frees the unique purchase_key so a mission
// whose seller window lapsed can be re-prepared. Refuses to touch any non-failed row.
export async function clearFailedPurchase(db: D1Database, purchaseKey: string): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM holo_x402_purchases WHERE purchase_key = ?1 AND status = 'failed'`)
    .bind(purchaseKey)
    .run();
  return Number(res.meta.changes ?? 0) === 1;
}

// Creator-gated in the real flow: flips prepared -> approved and stamps the approval record.
export async function approvePurchase(db: D1Database, purchaseKey: string, by: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE holo_x402_purchases SET status = 'approved', approval = ?1, updated_at = ?2 WHERE purchase_key = ?3 AND status = 'prepared'`)
    .bind(JSON.stringify({ by, at: nowIso() }), nowIso(), purchaseKey)
    .run();
  return Number(res.meta.changes ?? 0) === 1;
}

// The two safety constraints as a D1-backed guard. approve() re-checks the lock at signing time;
// begin() is the atomic single-claim; record() persists the outcome (settled vs uncertain).
export function createD1BuyGuard(db: D1Database): BuyGuard {
  return {
    async approve({ purchaseKey, network, asset, auth }) {
      const row = await getPurchaseByKey(db, purchaseKey);
      if (!row) return { approved: false, reason: "no prepared purchase for this key" };
      if (row.status !== "approved") return { approved: false, reason: `not approved (status=${row.status})` };
      if (!row.approval) return { approved: false, reason: "missing approval record" };
      const matches =
        row.network === network &&
        row.asset.toLowerCase() === asset.toLowerCase() &&
        row.pay_to.toLowerCase() === auth.to.toLowerCase() &&
        row.amount === auth.value &&
        row.nonce.toLowerCase() === auth.nonce.toLowerCase() &&
        String(row.valid_after) === auth.validAfter &&
        String(row.valid_before) === auth.validBefore &&
        (row.payer ?? "").toLowerCase() === auth.from.toLowerCase();
      return matches
        ? { approved: true }
        : { approved: false, reason: "authorization deviates from the approved params (re-prepare + re-approve)" };
    },

    async begin({ purchaseKey, auth }) {
      // Atomic approved -> in_flight, bound to the exact nonce. Only the first caller wins.
      const res = await db
        .prepare(
          `UPDATE holo_x402_purchases SET status = 'in_flight', updated_at = ?1
             WHERE purchase_key = ?2 AND status = 'approved' AND tx_hash IS NULL AND nonce = ?3`,
        )
        .bind(nowIso(), purchaseKey, auth.nonce)
        .run();
      return Number(res.meta.changes ?? 0) === 1
        ? { proceed: true }
        : { proceed: false, reason: "purchase already in flight or settled (slot not claimed)" };
    },

    async record({ purchaseKey, auth, receipt }) {
      const settled = receipt?.success === true && !!receipt.transaction;
      const status = settled ? "settled" : "uncertain";
      await db
        .prepare(
          `UPDATE holo_x402_purchases SET status = ?1, tx_hash = COALESCE(?2, tx_hash), payer = ?3, receipt = ?4, updated_at = ?5
             WHERE purchase_key = ?6`,
        )
        .bind(
          status,
          settled ? receipt!.transaction! : null,
          auth.from,
          receipt ? JSON.stringify(receipt) : null,
          nowIso(),
          purchaseKey,
        )
        .run();
    },
  };
}

function rpcUrlsFor(cfg: RuntimeConfig, network: string): string[] {
  if (network === ARC_MAINNET) return cfg.arcRpcUrls;
  if (network === BASE_MAINNET) return cfg.baseRpcUrls;
  return [];
}

// Read-only scan for the AuthorizationUsed event of a specific (authorizer, nonce). Returns the
// settling tx hash, or null when not found in the window. No signing, no key touches this path.
export async function findAuthorizationUsed(
  cfg: RuntimeConfig,
  network: string,
  asset: string,
  authorizer: string,
  nonce: string,
  windowBlocks = 5000,
): Promise<{ txHash: string; blockNumber: number } | null> {
  const urls = rpcUrlsFor(cfg, network);
  if (urls.length === 0) throw new Error(`no rpc urls for network ${network}`);
  return withRpcFallback(urls, async (url) => {
    const latest = Number(hexToUint(await rpcCall(url, "eth_blockNumber", [])));
    const fromBlock = Math.max(0, latest - windowBlocks);
    const logs = (await rpcCall(url, "eth_getLogs", [
      {
        address: asset,
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + latest.toString(16),
        topics: [AUTHORIZATION_USED_TOPIC, pad32(authorizer), nonce.toLowerCase()],
      },
    ])) as { transactionHash?: string; blockNumber?: string }[];
    for (const l of logs ?? []) {
      if (l?.transactionHash) return { txHash: l.transactionHash, blockNumber: Number(hexToUint(l.blockNumber ?? "0x0")) };
    }
    return null;
  });
}

export interface ReconcileResult {
  ok: boolean;
  settled?: boolean;
  txHash?: string;
  reason?: string;
}

// Resolve a purchase parked as 'uncertain'. Settled if the authorization was consumed on-chain;
// failed only once it has EXPIRED unsettled (after valid_before it can no longer be honored, so
// it is safe to re-prepare); otherwise it stays uncertain because a held authorization could
// still settle — retrying now would risk a double-pay.
export async function reconcileX402Purchase(
  db: D1Database,
  cfg: RuntimeConfig,
  purchaseKey: string,
  opts: { nowSeconds?: number } = {},
): Promise<ReconcileResult> {
  const row = await getPurchaseByKey(db, purchaseKey);
  if (!row) return { ok: false, reason: "no such purchase" };
  if (row.status !== "uncertain") return { ok: false, reason: `nothing to reconcile (status=${row.status})` };

  const authorizer = row.payer ?? cfg.publicWallet;
  const found = await findAuthorizationUsed(cfg, row.network, row.asset, authorizer, row.nonce).catch(() => null);
  if (found) {
    await db
      .prepare(`UPDATE holo_x402_purchases SET status = 'settled', tx_hash = ?1, updated_at = ?2 WHERE purchase_key = ?3`)
      .bind(found.txHash, nowIso(), purchaseKey)
      .run();
    return { ok: true, settled: true, txHash: found.txHash };
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now > row.valid_before) {
    await db
      .prepare(`UPDATE holo_x402_purchases SET status = 'failed', updated_at = ?1 WHERE purchase_key = ?2`)
      .bind(nowIso(), purchaseKey)
      .run();
    return { ok: true, settled: false, reason: "authorization expired unsettled; marked failed (safe to re-prepare)" };
  }
  return {
    ok: false,
    reason: "no on-chain settlement found yet and the authorization is still valid; remains uncertain (do NOT retry — it could still settle)",
  };
}

// Convenience for a caller that already holds a settlement receipt and wants the row's final
// status string for evidence/reporting.
export function statusFromReceipt(receipt: SettlementResponse | null): "settled" | "uncertain" {
  return receipt?.success === true && !!receipt.transaction ? "settled" : "uncertain";
}
