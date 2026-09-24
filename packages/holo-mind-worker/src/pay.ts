// Batch-3 payout rail: settle an approved mission's reward from Holo's own wallet,
// on-chain, with hash evidence. Real money — every send is gated behind:
//   1. wallet integrity (armed key must derive to the configured public wallet),
//   2. a fresh creator approval record whose locked params (amount, recipient) match,
//   3. an atomic D1 slot claim (approved -> paying) so concurrent pays cannot double-send,
//   4. a refusal to pay twice (tx_hash already set).
// Arc settles USDC as the NATIVE gas token (value transfer); Base settles ERC-20 USDC.
// Circle Facilitator / EIP-3009 is reserved for x402 service-purchase flows, not payouts.
import { createWalletClient, http, isAddress, parseUnits, defineChain, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { Env, RuntimeConfig } from "./config.js";
import { assertWalletIntegrity } from "./wallet.js";
import { getMission, setMissionStatus, setMissionTxHash } from "./store.js";
import { rpcCall, withRpcFallback, hexToUint, TRANSFER_TOPIC, assertPayeeIsWallet } from "./rpc.js";

const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const DECIMALS_SELECTOR = "0x313ce567";
const TRANSFER_SELECTOR = "0xa9059cbb";

export interface PayResult {
  ok: boolean;
  reason?: string;
  txHash?: string;
  chain?: string;
  amountUsd?: number;
  recipient?: string;
}

const safeJson = (s: string | null | undefined): any => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// Atomically claim the single payment slot for a mission. Returns true only for the one
// caller that flips approved -> paying; any concurrent/second pay attempt gets false and
// must not send. This is the concurrency half of the double-payment guard.
async function claimPaymentSlot(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE holo_missions SET status = 'paying', updated_at = ?1 WHERE id = ?2 AND status = 'approved' AND tx_hash IS NULL`)
    .bind(new Date().toISOString(), id)
    .run();
  return Number(res.meta.changes ?? 0) === 1;
}

async function baseUsdcDecimals(urls: string[]): Promise<number> {
  return withRpcFallback(urls, async (url) => {
    const hex = await rpcCall(url, "eth_call", [{ to: BASE_USDC_ADDRESS, data: DECIMALS_SELECTOR }, "latest"]);
    return Number(hexToUint(hex));
  });
}

function transferData(to: Address, amountRaw: bigint): `0x${string}` {
  return (TRANSFER_SELECTOR + to.toLowerCase().replace("0x", "").padStart(64, "0") + amountRaw.toString(16).padStart(64, "0")) as `0x${string}`;
}

export async function payApprovedMission(env: Env, cfg: RuntimeConfig, id: number): Promise<PayResult> {
  // 1. Integrity: never sign with a key that does not control the configured wallet.
  try {
    assertWalletIntegrity(cfg);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (!cfg.walletKey) return { ok: false, reason: "no wallet key (disarmed)" };

  const m = await getMission(env.DB, id);
  if (!m) return { ok: false, reason: "no such mission" };
  // 4. Never pay twice.
  if (m.tx_hash) return { ok: false, reason: `already settled (${m.tx_hash})` };
  if (m.status !== "approved") return { ok: false, reason: `not approved (status=${m.status})` };

  // 2. Approval record must exist and its locked params must match the mission exactly.
  const approval = safeJson(m.approval);
  const delivery = safeJson(m.delivery);
  if (!approval || !delivery) return { ok: false, reason: "missing approval or delivery record" };
  if (Number(approval.amountCents) !== Number(m.reward_cents)) {
    return { ok: false, reason: "approval amount != mission reward (params changed; re-approve)" };
  }
  const recipient = String(delivery.recipient ?? "");
  if (String(approval.recipient ?? "") !== recipient) {
    return { ok: false, reason: "approval recipient != delivery recipient (params changed; re-approve)" };
  }
  if (!isAddress(recipient)) return { ok: false, reason: "recipient is not a valid address" };
  const amountUsd = m.reward_cents / 100;
  if (!(amountUsd > 0)) return { ok: false, reason: "non-positive amount" };

  // Payee safety: refuse to send to a contract address (EOA-only). Checked BEFORE the slot
  // claim so a refusal leaves the mission 'approved' and retryable rather than stuck 'paying'.
  // Fail-closed: an unverifiable payee (rpc error) is refused, not paid.
  const payeeUrls = m.chain === "base" ? cfg.baseRpcUrls : cfg.arcRpcUrls;
  const payeeOk = await assertPayeeIsWallet(payeeUrls, recipient);
  if (!payeeOk.ok) return { ok: false, reason: payeeOk.reason };

  // 3. Atomic slot claim (concurrency double-pay guard).
  const claimed = await claimPaymentSlot(env.DB, id);
  if (!claimed) return { ok: false, reason: "payment already in flight or settled (slot not claimed)" };

  const account = privateKeyToAccount(cfg.walletKey as `0x${string}`);
  let txHash: `0x${string}`;
  try {
    if (m.chain === "base") {
      const decimals = await baseUsdcDecimals(cfg.baseRpcUrls);
      const amountRaw = parseUnits(amountUsd.toFixed(decimals > 6 ? 6 : decimals), decimals);
      const client = createWalletClient({ account, chain: base, transport: http(cfg.baseRpcUrls[0]) });
      txHash = await client.sendTransaction({
        to: BASE_USDC_ADDRESS,
        data: transferData(recipient as Address, amountRaw),
        chain: base,
      });
    } else {
      // Arc: USDC is the native gas token -> plain value transfer at the configured
      // native decimals (18 on Arc mainnet; no on-chain decimals() to ask).
      const dec = cfg.arcNativeDecimals;
      const amountRaw = parseUnits(amountUsd.toFixed(dec), dec);
      const arc = defineChain({
        id: 5042,
        name: "Arc",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: dec },
        rpcUrls: { default: { http: [cfg.arcRpcUrls[0]] } },
      });
      const client = createWalletClient({ account, chain: arc, transport: http(cfg.arcRpcUrls[0]) });
      txHash = await client.sendTransaction({ to: recipient as Address, value: amountRaw });
    }
  } catch (e) {
    // Broadcast state is unknown here (the tx may or may not have gone out). NEVER return
    // to 'approved' — that would permit a blind second send. Park as payment_uncertain.
    await setMissionStatus(env.DB, id, "payment_uncertain");
    return {
      ok: false,
      reason: `send failed or network-uncertain: ${(e as Error).message}; status=payment_uncertain; reconcile before any retry`,
    };
  }
  try {
    await setMissionTxHash(env.DB, id, txHash);
  } catch (e) {
    // Money moved but the record did not. Park as uncertain carrying the tx so a human can
    // reconcile; never re-send from 'approved'.
    await setMissionStatus(env.DB, id, "payment_uncertain");
    return {
      ok: false,
      reason: `broadcast succeeded (tx ${txHash}) but recording failed: ${(e as Error).message}; status=payment_uncertain; reconcile with this tx`,
      txHash,
    };
  }
  return { ok: true, txHash, chain: m.chain, amountUsd, recipient };
}

// Find an already-on-chain payment from Holo's wallet to the recipient for the exact amount
// over a recent window. Base: ERC-20 Transfer logs filtered by from+to. Arc: native value
// transfers scanned from recent full blocks. Returns the tx hash or null.
async function findMatchingOutflow(
  cfg: RuntimeConfig,
  chain: string,
  recipient: string,
  amountUsd: number,
): Promise<string | null> {
  const fromTopic = "0x" + cfg.publicWallet.toLowerCase().replace("0x", "").padStart(64, "0");
  const toTopic = "0x" + recipient.toLowerCase().replace("0x", "").padStart(64, "0");
  if (chain === "base") {
    const url = cfg.baseRpcUrls[0];
    const latest = Number(hexToUint(await rpcCall(url, "eth_blockNumber", [])));
    const fromBlock = Math.max(0, latest - 2000);
    const logs = (await rpcCall(url, "eth_getLogs", [
      {
        address: BASE_USDC_ADDRESS,
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + latest.toString(16),
        topics: [TRANSFER_TOPIC, fromTopic, toTopic],
      },
    ]).catch(() => null)) as { transactionHash?: string; data?: string }[] | null;
    const dec = await baseUsdcDecimals(cfg.baseRpcUrls).catch(() => 6);
    const want = parseUnits(amountUsd.toFixed(dec > 6 ? 6 : dec), dec);
    for (const l of logs ?? []) {
      if (l?.data && BigInt(l.data) === want && l.transactionHash) return l.transactionHash;
    }
    return null;
  }
  const url = cfg.arcRpcUrls[0];
  const latest = Number(hexToUint(await rpcCall(url, "eth_blockNumber", [])));
  const want = parseUnits(amountUsd.toFixed(cfg.arcNativeDecimals), cfg.arcNativeDecimals);
  for (let b = latest; b > latest - 100 && b >= 0; b--) {
    const blk = (await rpcCall(url, "eth_getBlockByNumber", ["0x" + b.toString(16), true]).catch(() => null)) as any;
    for (const tx of blk?.transactions ?? []) {
      if (
        String(tx.from ?? "").toLowerCase() === cfg.publicWallet.toLowerCase() &&
        String(tx.to ?? "").toLowerCase() === recipient.toLowerCase() &&
        BigInt(tx.value ?? "0x0") === want
      ) {
        return String(tx.hash);
      }
    }
  }
  return null;
}

// Creator-driven reconciliation for a mission parked in payment_uncertain. Either record a
// supplied tx after verifying it on-chain (wallet -> recipient -> exact amount), or, when a
// scan finds no matching on-chain payment, allow an explicit reset back to approved.
export async function reconcileMission(
  env: Env,
  cfg: RuntimeConfig,
  id: number,
  opts: { txHash?: string; reset?: boolean },
): Promise<PayResult> {
  const m = await getMission(env.DB, id);
  if (!m) return { ok: false, reason: "no such mission" };
  if (m.status !== "payment_uncertain") return { ok: false, reason: `nothing to reconcile (status=${m.status})` };
  const delivery = safeJson(m.delivery);
  const recipient = String(delivery?.recipient ?? "");
  const amountUsd = m.reward_cents / 100;
  const provided = String(opts.txHash ?? "").trim();
  if (provided) {
    const url = m.chain === "base" ? cfg.baseRpcUrls[0] : cfg.arcRpcUrls[0];
    const tx = (await rpcCall(url, "eth_getTransactionByHash", [provided]).catch(() => null)) as any;
    if (!tx) return { ok: false, reason: "tx not found on chain" };
    const okFrom = String(tx.from ?? "").toLowerCase() === cfg.publicWallet.toLowerCase();
    const okTo =
      String(tx.to ?? "").toLowerCase() ===
      (m.chain === "base" ? BASE_USDC_ADDRESS.toLowerCase() : recipient.toLowerCase());
    let okValue = true;
    if (m.chain === "base") {
      const dec = await baseUsdcDecimals(cfg.baseRpcUrls).catch(() => 6);
      okValue =
        BigInt("0x" + String(tx.input ?? "0x").slice(-64)) === parseUnits(amountUsd.toFixed(dec > 6 ? 6 : dec), dec);
    } else {
      okValue = BigInt(tx.value ?? "0x0") === parseUnits(amountUsd.toFixed(cfg.arcNativeDecimals), cfg.arcNativeDecimals);
    }
    if (okFrom && okTo && okValue) {
      await setMissionTxHash(env.DB, id, provided);
      return { ok: true, txHash: provided, chain: m.chain, amountUsd, recipient };
    }
    return { ok: false, reason: "tx does not match wallet -> recipient -> exact amount" };
  }
  const found = await findMatchingOutflow(cfg, m.chain, recipient, amountUsd).catch(() => null);
  if (found) {
    await setMissionTxHash(env.DB, id, found);
    return { ok: true, txHash: found, chain: m.chain, amountUsd, recipient };
  }
  if (opts.reset === true) {
    await setMissionStatus(env.DB, id, "approved");
    return { ok: true, reason: "no matching on-chain payment found in scan window; reset to approved" };
  }
  return { ok: false, reason: "no matching on-chain payment found; supply txHash to record it, or reset:true to re-enable pay" };
}
