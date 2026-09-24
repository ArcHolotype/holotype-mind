// x402 BUYER rail wiring: turns the pure buyer protocol (x402.ts) + its D1 guard (x402guard.ts)
// into a real, gated payment path. Two creator-driven phases, mirroring the vanilla payout rail:
//
//   prepare — fetch the seller's 402, fail-closed-select a signable requirement, then lock the
//             EXACT EIP-3009 authorization into a 'prepared' row. NO signing, NO money. This row
//             is the card the creator reviews.
//   pay     — the creator's single "PAY NOW": approve the prepared row, then sign + settle through
//             buyResource. Real money. Gated behind wallet integrity, the per-purchase + daily
//             caps, the approval param-lock (constraint ①) and the atomic single-pay claim
//             (constraint ②) — all of which buyResource + the D1 guard enforce.
//
// NOTE on payee type: unlike the vanilla rail (which on Arc sends NATIVE USDC, so a contract
// recipient would execute code on receipt), an x402 settlement is an ERC-20 USDC
// transferWithAuthorization — the token contract credits payTo and runs NO code at payTo. So we
// deliberately do NOT impose an EOA-only rule here (it would reject legitimate sellers that
// receive into a smart-contract/Gateway wallet, with no security benefit). The x402 spec puts no
// EOA requirement on payTo. The real safeguard is that payTo is locked into the authorization the
// creator sees and confirms before PAY NOW. (Gateway *batching* sellers are still refused earlier,
// in x402.ts selectAccept, for the separate custodial-deposit reason.)
//
// The brain may PROPOSE a buy (policy allows recording a `buy` intent), but proposing moves no
// money: nothing is fetched, signed or settled until the creator drives prepare -> pay here.
// This module holds the viem signer adapter; x402.ts itself stays key-free and chain-agnostic.

import { privateKeyToAccount } from "viem/accounts";
import type { Env, RuntimeConfig } from "./config.js";
import { assertWalletIntegrity } from "./wallet.js";
import {
  atomicToUsd,
  buildAuthorization,
  buyResource,
  defaultBuyPolicy,
  parsePaymentRequired,
  randomNonce,
  selectAccept,
  type BuyPolicy,
  type BuySigner,
  type Eip3009Authorization,
  type FetchLike,
  type Hex,
} from "./x402.js";
import {
  approvePurchase,
  clearFailedPurchase,
  countX402CommittedToday,
  createD1BuyGuard,
  getPurchaseByKey,
  preparePurchase,
  type X402PurchaseRow,
} from "./x402guard.js";

// The x402 asset is USDC on both Arc and Base (6 decimals), so atomic units per cent = 1e4.
const ATOMIC_PER_CENT = 10_000n;

// capCents overrides the per-purchase ceiling for a single purchase (e.g. bound it to a
// mission's agreed reward). It is always clamped to the configured x402 cap — a caller can
// tighten the ceiling but never raise it above the global $-per-purchase cap.
export function x402BuyPolicy(cfg: RuntimeConfig, capCents?: number): BuyPolicy {
  const cents = capCents != null ? Math.min(capCents, cfg.x402MaxPerPurchaseCents) : cfg.x402MaxPerPurchaseCents;
  return defaultBuyPolicy({
    maxAmountAtomic: BigInt(cents) * ATOMIC_PER_CENT,
    maxTimeoutSeconds: cfg.x402MaxTimeoutSeconds,
  });
}

const dayPrefix = () => new Date().toISOString().slice(0, 10);

export interface PurchaseCard {
  purchaseKey: string;
  network: string;
  asset: string;
  payTo: string;
  amountUsd: number;
  validAfter: number;
  validBefore: number;
  resource: unknown;
  version: 1 | 2;
}

export interface PrepareResult {
  ok: boolean;
  reason?: string;
  id?: number;
  card?: PurchaseCard;
}

export interface PrepareOptions {
  url: string;
  purchaseKey: string;
  method?: "GET" | "POST";
  body?: unknown;
  // Tighten the per-purchase ceiling for this purchase (e.g. a mission's agreed reward).
  // Always clamped to the configured x402 cap; never raises it.
  maxAmountCents?: number;
  fetchImpl?: FetchLike;
  nowSeconds?: () => number;
  nonce?: () => Hex;
}

// Phase 1 — build the review card. Moves NO money and signs nothing.
export async function prepareX402Purchase(
  env: Env,
  cfg: RuntimeConfig,
  opts: PrepareOptions,
): Promise<PrepareResult> {
  const url = String(opts.url ?? "").trim();
  const purchaseKey = String(opts.purchaseKey ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "a valid http(s) seller url is required" };
  if (!purchaseKey) return { ok: false, reason: "purchaseKey is required" };

  // One live purchase per key. A prior 'failed' row (expired unsettled) may be re-prepared.
  const existing = await getPurchaseByKey(env.DB, purchaseKey);
  if (existing && existing.status !== "failed") {
    return { ok: false, reason: `a purchase for this key already exists (status=${existing.status})` };
  }

  const committedToday = await countX402CommittedToday(env.DB, dayPrefix());
  if (committedToday >= cfg.x402MaxPerDay) {
    return { ok: false, reason: `x402 daily cap reached (${cfg.x402MaxPerDay} per day)` };
  }

  // Fetch the unpaid resource -> expect a 402 carrying the seller's requirements.
  const f: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init as RequestInit) as never);
  const method = opts.method ?? "GET";
  const reqBody = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  let first;
  try {
    first = await f(url, { method, headers: { accept: "application/json" }, body: reqBody });
  } catch (e) {
    return { ok: false, reason: `seller request failed: ${(e as Error).message}` };
  }
  if (first.status === 200) return { ok: false, reason: "resource is free (no 402 challenge); nothing to buy" };
  if (first.status !== 402) return { ok: false, reason: `expected a 402 challenge, got ${first.status}` };
  const firstBody = await first.json().catch(() => null);
  const required = parsePaymentRequired(first, firstBody);
  if (!required) return { ok: false, reason: "402 without parseable payment requirements" };

  // Fail-closed selection (scheme/method/network/asset/amount cap all enforced here).
  const capCents = opts.maxAmountCents != null ? Math.min(opts.maxAmountCents, cfg.x402MaxPerPurchaseCents) : cfg.x402MaxPerPurchaseCents;
  const policy = x402BuyPolicy(cfg, capCents);
  const sel = selectAccept(required.accepts, policy);
  if (!sel.accept || sel.chainId === undefined) {
    return { ok: false, reason: sel.reason ?? "no signable requirement" };
  }
  const accept = sel.accept;

  // Per-purchase cap in the cents view (selectAccept already enforced the atomic cap).
  const amountUsd = atomicToUsd(accept.amount);
  if (Math.round(amountUsd * 100) > capCents) {
    return { ok: false, reason: `amount $${amountUsd} exceeds the $${capCents / 100} per-purchase cap` };
  }

  const now = (opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const built = buildAuthorization({
    accept,
    chainId: sel.chainId,
    from: cfg.publicWallet as Hex,
    nonce: (opts.nonce ?? randomNonce)(),
    nowSeconds: now,
    maxTimeoutSeconds: policy.maxTimeoutSeconds,
  });

  const id = await preparePurchase(env.DB, {
    purchaseKey,
    network: accept.network,
    asset: accept.asset,
    resourceUrl: url,
    payer: cfg.publicWallet,
    auth: built.auth,
  });

  return {
    ok: true,
    id,
    card: {
      purchaseKey,
      network: accept.network,
      asset: accept.asset,
      payTo: accept.payTo,
      amountUsd,
      validAfter: Number(built.auth.validAfter),
      validBefore: Number(built.auth.validBefore),
      resource: required.resource ?? null,
      version: required.version,
    },
  };
}

export interface ExecuteResult {
  ok: boolean;
  reason?: string;
  status?: string;
  transaction?: string;
  network?: string;
  payer?: string;
  amountUsd?: number;
}

export interface ExecuteOptions {
  fetchImpl?: FetchLike;
  nowSeconds?: () => number;
}

// Build the injected signer from the armed wallet key, asserting it controls the public wallet.
function signerFromCfg(cfg: RuntimeConfig): BuySigner {
  assertWalletIntegrity(cfg); // throws if the armed key does not derive to the configured wallet
  if (!cfg.walletKey) throw new Error("no wallet key (disarmed)");
  const account = privateKeyToAccount(cfg.walletKey as `0x${string}`);
  if (account.address.toLowerCase() !== cfg.publicWallet.toLowerCase()) {
    throw new Error("signer address != configured public wallet");
  }
  return {
    address: account.address as Hex,
    signTypedData: (req) => account.signTypedData(req as never) as Promise<Hex>,
  };
}

// Phase 2 — the creator's single "PAY NOW". Approves the prepared row and settles it. Real money.
export async function executeX402Purchase(
  env: Env,
  cfg: RuntimeConfig,
  purchaseKey: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const key = String(purchaseKey ?? "").trim();
  const row = await getPurchaseByKey(env.DB, key);
  if (!row) return { ok: false, reason: "no such purchase" };
  if (row.status === "settled") return { ok: false, reason: `already settled (${row.tx_hash})` };
  if (!["prepared", "approved"].includes(row.status)) {
    return { ok: false, reason: `cannot pay (status=${row.status})` };
  }

  // Wallet integrity + signer BEFORE any state change (throws -> refused, nothing approved).
  let signer: BuySigner;
  try {
    signer = signerFromCfg(cfg);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }

  // Daily cap counts committed purchases; a 'prepared' row is not yet committed, so this is the
  // gate that actually bounds how many purchases settle in a day.
  const committedToday = await countX402CommittedToday(env.DB, dayPrefix());
  if (committedToday >= cfg.x402MaxPerDay) {
    return { ok: false, reason: `x402 daily cap reached (${cfg.x402MaxPerDay} per day)` };
  }

  // Per-purchase cap re-check from the locked row (defence in depth).
  const amountUsd = atomicToUsd(row.amount);
  if (Math.round(amountUsd * 100) > cfg.x402MaxPerPurchaseCents) {
    return { ok: false, reason: `amount $${amountUsd} exceeds the per-purchase cap` };
  }

  // The authorization window is seller-bounded; if it lapsed the signature could not settle,
  // so refuse and ask for a re-prepare rather than sign a dead authorization.
  const now = (opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  if (now > row.valid_before) {
    return { ok: false, reason: "the prepared authorization window expired; re-prepare the purchase" };
  }

  // Single-click PAY NOW: approve the prepared row (stamps the approval record), then execute.
  if (row.status === "prepared") {
    const approved = await approvePurchase(env.DB, key, "creator");
    if (!approved) return { ok: false, reason: "could not approve the prepared purchase (state changed)" };
  }

  const preparedAuth: Eip3009Authorization = {
    from: row.payer as Hex,
    to: row.pay_to as Hex,
    value: row.amount,
    validAfter: String(row.valid_after),
    validBefore: String(row.valid_before),
    nonce: row.nonce as Hex,
  };

  const out = await buyResource(row.resource_url, {
    signer,
    policy: x402BuyPolicy(cfg),
    guard: createD1BuyGuard(env.DB),
    purchaseKey: key,
    preparedAuth,
    fetchImpl: opts.fetchImpl,
    nowSeconds: opts.nowSeconds,
  });

  const finalRow = await getPurchaseByKey(env.DB, key);
  return {
    ok: out.ok,
    reason: out.reason,
    status: finalRow?.status,
    transaction: out.transaction,
    network: out.network,
    payer: out.payer,
    amountUsd,
  };
}

// Rebuild the review card from a stored row (so a re-click shows the same locked terms).
function cardFromRow(row: X402PurchaseRow): PurchaseCard {
  return {
    purchaseKey: row.purchase_key,
    network: row.network,
    asset: row.asset,
    payTo: row.pay_to,
    amountUsd: atomicToUsd(row.amount),
    validAfter: row.valid_after,
    validBefore: row.valid_before,
    resource: { url: row.resource_url },
    version: 2,
  };
}

// Idempotent prepare for the mission-driven flow: return the existing card if one is already
// prepared/approved, refuse if it is mid-flight/settled/uncertain, and re-prepare a row that
// reconcile marked 'failed' (its window expired unsettled, so no money moved). Otherwise prepare
// fresh. This is what the creator's PAY NOW button calls first to fetch the live seller terms.
export async function getOrPrepareX402Purchase(
  env: Env,
  cfg: RuntimeConfig,
  opts: PrepareOptions,
): Promise<PrepareResult> {
  const existing = await getPurchaseByKey(env.DB, String(opts.purchaseKey ?? "").trim());
  if (existing) {
    if (existing.status === "prepared" || existing.status === "approved") {
      return { ok: true, id: existing.id, card: cardFromRow(existing) };
    }
    if (existing.status !== "failed") {
      return { ok: false, reason: `purchase already ${existing.status} (cannot re-prepare)` };
    }
    await clearFailedPurchase(env.DB, existing.purchase_key);
  }
  return prepareX402Purchase(env, cfg, opts);
}
