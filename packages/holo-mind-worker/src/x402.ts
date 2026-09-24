// x402 BUYER-side infrastructure: lets Holo purchase a resource from an x402 seller.
// Holo is the payer; it signs an EIP-3009 `transferWithAuthorization` over the seller's
// advertised requirements and hands the signature back in the payment header. Holo never
// broadcasts and never pays gas — the SELLER's facilitator settles the signed authorization
// on-chain and cannot change the amount or the destination (they are inside the signature).
//
// Fail-closed by construction: nothing is signed until the seller's requirement matches an
// explicit allowlist (scheme=exact, method=eip3009, network, asset) AND is within the amount
// cap AND the caller's guard approves the exact authorization and claims the purchase slot.
// Any unknown scheme / asset-transfer method / network / asset is refused before signing.
//
// This module is pure protocol + orchestration: it holds no key and imports no chain library.
// Signing is injected (BuySigner) so the wire format stays unit-testable with zero real money.
//
// Scope: only the `exact` scheme with the `eip3009` asset-transfer method is supported. Circle
// Gateway *batching* (extra.name "GatewayWalletBatched") is intentionally NOT supported — we do
// not use batching, and it would require a custodial Gateway deposit. Such a seller is refused
// before anything is signed; if one is ever needed it is a separate, explicitly-approved build.

export type Hex = `0x${string}`;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^[0-9]+$/;

export const isAddress = (s: unknown): s is Hex => typeof s === "string" && ADDR_RE.test(s);
export const isBytes32 = (s: unknown): s is Hex => typeof s === "string" && BYTES32_RE.test(s);

// ---- canonical networks + verified USDC assets ----
// Arc mainnet USDC (0x3600…0000) was verified read-only on-chain at chainId 5042: it is a
// contract, symbol/name "USDC", 6 decimals, exposes authorizationState (EIP-3009), and its
// DOMAIN_SEPARATOR equals keccak of the EIP-712 domain {name:"USDC",version:"2",chainId:5042,
// verifyingContract:0x3600…0000}. So the domain pinned below is exactly what the contract
// recovers against — a buyer signature over it will verify. Base USDC is the canonical address
// already used for balance reads in rpc.ts; its EIP-712 domain is NOT pinned here (a live Base
// purchase must verify name/version first), so Base falls back to the seller-advertised extra.
export const ARC_MAINNET = "eip155:5042";
export const BASE_MAINNET = "eip155:8453";
export const ARC_MAINNET_USDC = "0x3600000000000000000000000000000000000000" as Hex;
export const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex;

// network:asset(lowercased) -> the EIP-712 domain confirmed against the contract on-chain.
export const VERIFIED_EIP712_DOMAIN: Record<string, { name: string; version: string }> = {
  [`${ARC_MAINNET}:${ARC_MAINNET_USDC.toLowerCase()}`]: { name: "USDC", version: "2" },
};

// Default buyer policy: Arc + Base mainnet, the verified USDC assets, eip3009 only (selectAccept
// enforces scheme/method), and caller-supplied caps. Amounts are atomic USDC (6 decimals).
export function defaultBuyPolicy(opts: { maxAmountAtomic: bigint; maxTimeoutSeconds?: number }): BuyPolicy {
  return {
    allowNetworks: [ARC_MAINNET, BASE_MAINNET],
    allowAssets: {
      [ARC_MAINNET]: [ARC_MAINNET_USDC],
      [BASE_MAINNET]: [BASE_MAINNET_USDC],
    },
    maxAmountAtomic: opts.maxAmountAtomic,
    maxTimeoutSeconds: opts.maxTimeoutSeconds,
  };
}

// ---- EIP-3009 typed data (exact scheme, eip3009 asset-transfer method) ----

export interface Eip3009Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Hex;
}

// Wire form of the authorization (decimal strings for uint fields, as the spec advertises).
export interface Eip3009Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

// EIP-712 message form (uint256 as bigint) used for signing.
export interface Eip3009Message {
  from: Hex;
  to: Hex;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface SignTypedDataRequest {
  domain: Eip3009Domain;
  types: { TransferWithAuthorization: readonly { name: string; type: string }[] };
  primaryType: "TransferWithAuthorization";
  message: Eip3009Message;
}

// Injected signer: the real flow adapts Holo's viem account; tests adapt a Hardhat key.
export interface BuySigner {
  address: Hex;
  signTypedData: (req: SignTypedDataRequest) => Promise<Hex>;
}

// ---- base64 (Worker + Node safe, unicode tolerant) ----

export function b64encodeJson(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decodeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    const bin = atob(s.trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

export function randomNonce(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
}

// ---- normalized seller requirement ----

export interface AcceptEntry {
  scheme: string;
  network: string;
  asset: Hex;
  amount: string; // atomic USDC units, decimal string
  payTo: Hex;
  maxTimeoutSeconds: number;
  method: string; // assetTransferMethod: eip3009 | permit2 | erc7710 | "" (default eip3009)
  domainName: string; // EIP-712 domain name from extra.name (default "USDC")
  domainVersion: string; // EIP-712 domain version from extra.version (default "2")
  gateway: boolean; // true when the seller wants Circle Gateway batching (unsupported here)
  raw: Record<string, unknown>; // the exact advertised object, echoed back when signing
}

export interface ResourceInfo {
  url?: string;
  description?: string;
  mimeType?: string;
}

export interface ParsedRequired {
  version: 1 | 2;
  resource?: ResourceInfo;
  accepts: AcceptEntry[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function normalizeAccept(raw: Record<string, unknown>): AcceptEntry | null {
  const extra = (raw.extra ?? {}) as Record<string, unknown>;
  const asset = str(raw.asset);
  const payTo = str(raw.payTo);
  if (!isAddress(asset) || !isAddress(payTo)) return null;
  const amount = str(raw.amount ?? raw.maxAmountRequired);
  if (!UINT_RE.test(amount)) return null;
  const method = str(extra.assetTransferMethod).toLowerCase();
  const domainName = str(extra.name) || "USDC";
  return {
    scheme: str(raw.scheme).toLowerCase(),
    network: str(raw.network),
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: Number(raw.maxTimeoutSeconds ?? 60),
    method,
    domainName,
    domainVersion: str(extra.version) || "2",
    // Gateway batching advertises a non-USDC domain name and a gateway verifyingContract.
    gateway: domainName.toLowerCase().includes("gateway") || isAddress(extra.verifyingContract),
    raw,
  };
}

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponseLike>;

// Parse a 402 into normalized requirements. V2 carries them in the PAYMENT-REQUIRED header;
// V1 carries them in the JSON body. Returns null when neither is present/parseable.
export function parsePaymentRequired(res: HttpResponseLike, body: unknown): ParsedRequired | null {
  const v2 = b64decodeJson<Record<string, unknown>>(res.headers.get("PAYMENT-REQUIRED"));
  if (v2 && Array.isArray(v2.accepts)) {
    const accepts = (v2.accepts as Record<string, unknown>[]).map(normalizeAccept).filter((a): a is AcceptEntry => a !== null);
    return { version: 2, resource: (v2.resource as ResourceInfo) ?? undefined, accepts };
  }
  const v1 = (body ?? null) as Record<string, unknown> | null;
  if (v1 && Number(v1.x402Version) === 1 && Array.isArray(v1.accepts)) {
    const accepts = (v1.accepts as Record<string, unknown>[]).map(normalizeAccept).filter((a): a is AcceptEntry => a !== null);
    return { version: 1, accepts };
  }
  return null;
}

// ---- fail-closed selection ----

export interface BuyPolicy {
  allowNetworks: string[]; // CAIP-2, e.g. ["eip155:5042", "eip155:8453"]
  allowAssets: Record<string, string[]>; // network -> verified asset addresses (lowercased compare)
  maxAmountAtomic: bigint; // hard cap in atomic USDC units
  maxTimeoutSeconds?: number; // clamp on the validity window we are willing to sign
  networkChainIds?: Record<string, number>; // optional override for non-CAIP network strings
}

export interface SelectResult {
  accept?: AcceptEntry;
  chainId?: number;
  reason?: string;
}

export function resolveChainId(network: string, overrides?: Record<string, number>): number | null {
  if (overrides && network in overrides) return overrides[network];
  const m = /^eip155:(\d+)$/.exec(network);
  return m ? Number(m[1]) : null;
}

// Pick the first requirement we are willing to sign, or return a precise refusal reason.
export function selectAccept(accepts: AcceptEntry[], policy: BuyPolicy): SelectResult {
  if (accepts.length === 0) return { reason: "seller advertised no payment requirements" };
  const refusals: string[] = [];
  for (const a of accepts) {
    if (a.scheme !== "exact") {
      refusals.push(`scheme "${a.scheme}" != exact`);
      continue;
    }
    if (a.gateway) {
      refusals.push("Circle Gateway batching not supported by this buyer");
      continue;
    }
    if (a.method && a.method !== "eip3009") {
      refusals.push(`assetTransferMethod "${a.method}" != eip3009`);
      continue;
    }
    if (!policy.allowNetworks.includes(a.network)) {
      refusals.push(`network "${a.network}" not allowed`);
      continue;
    }
    const allowed = (policy.allowAssets[a.network] ?? []).map((x) => x.toLowerCase());
    if (!allowed.includes(a.asset.toLowerCase())) {
      refusals.push(`asset "${a.asset}" not verified for ${a.network}`);
      continue;
    }
    if (BigInt(a.amount) > policy.maxAmountAtomic) {
      refusals.push(`amount ${a.amount} exceeds cap ${policy.maxAmountAtomic}`);
      continue;
    }
    const chainId = resolveChainId(a.network, policy.networkChainIds);
    if (chainId === null) {
      refusals.push(`cannot resolve chainId for network "${a.network}"`);
      continue;
    }
    return { accept: a, chainId };
  }
  return { reason: `no signable requirement (${refusals.join("; ")})` };
}

// ---- authorization construction ----

export interface BuildInput {
  accept: AcceptEntry;
  chainId: number;
  from: Hex;
  nonce: Hex;
  nowSeconds: number;
  maxTimeoutSeconds?: number;
}

export interface BuiltAuthorization {
  auth: Eip3009Authorization;
  domain: Eip3009Domain;
  message: Eip3009Message;
}

// EIP-712 domain + signing message for an EXISTING authorization against a selected
// requirement. The domain name/version are pinned to the on-chain-verified values for known
// assets, so a seller advertising a bogus extra.name/version cannot steer the signature.
export function eip712For(
  accept: AcceptEntry,
  chainId: number,
  auth: Eip3009Authorization,
): { domain: Eip3009Domain; message: Eip3009Message } {
  const pinned = VERIFIED_EIP712_DOMAIN[`${accept.network}:${accept.asset.toLowerCase()}`];
  const domain: Eip3009Domain = {
    name: pinned?.name ?? accept.domainName,
    version: pinned?.version ?? accept.domainVersion,
    chainId,
    verifyingContract: accept.asset,
  };
  const message: Eip3009Message = {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  };
  return { domain, message };
}

export function buildAuthorization(input: BuildInput): BuiltAuthorization {
  const { accept, chainId, from, nonce, nowSeconds } = input;
  if (!isAddress(from)) throw new Error("signer address is not a valid address");
  if (!isBytes32(nonce)) throw new Error("nonce is not bytes32");
  const cap = input.maxTimeoutSeconds ?? accept.maxTimeoutSeconds;
  const window = Math.max(1, Math.min(accept.maxTimeoutSeconds, cap));
  const auth: Eip3009Authorization = {
    from,
    to: accept.payTo,
    value: accept.amount,
    validAfter: String(nowSeconds),
    validBefore: String(nowSeconds + window),
    nonce,
  };
  const { domain, message } = eip712For(accept, chainId, auth);
  return { auth, domain, message };
}

// Constraint ①: an approval card locks the exact authorization params. Any deviation means the
// thing about to be signed is not the thing that was approved ("approve A, pay B") -> refuse.
export interface ApprovalLock {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  network: string;
  asset: string;
}

export function authorizationMatchesLock(
  auth: Eip3009Authorization,
  ctx: { network: string; asset: string },
  lock: ApprovalLock,
): boolean {
  return (
    auth.from.toLowerCase() === lock.from.toLowerCase() &&
    auth.to.toLowerCase() === lock.to.toLowerCase() &&
    auth.value === lock.value &&
    auth.validAfter === lock.validAfter &&
    auth.validBefore === lock.validBefore &&
    auth.nonce.toLowerCase() === lock.nonce.toLowerCase() &&
    ctx.network === lock.network &&
    ctx.asset.toLowerCase() === lock.asset.toLowerCase()
  );
}

// ---- header encode / receipt decode ----

export function encodePaymentHeader(
  version: 1 | 2,
  parts: { resource?: ResourceInfo; accept: AcceptEntry; signature: Hex; auth: Eip3009Authorization },
): string {
  const payload = { signature: parts.signature, authorization: { ...parts.auth } };
  if (version === 2) {
    return b64encodeJson({
      x402Version: 2,
      resource: parts.resource ?? undefined,
      accepted: parts.accept.raw,
      payload,
    });
  }
  return b64encodeJson({
    x402Version: 1,
    scheme: "exact",
    network: parts.accept.network,
    payload,
  });
}

export const paymentHeaderName = (version: 1 | 2): string => (version === 2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT");
export const receiptHeaderName = (version: 1 | 2): string => (version === 2 ? "PAYMENT-RESPONSE" : "X-PAYMENT-RESPONSE");

export interface SettlementResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

export function decodeSettlement(res: HttpResponseLike, version: 1 | 2): SettlementResponse | null {
  return b64decodeJson<SettlementResponse>(res.headers.get(receiptHeaderName(version)));
}

// ---- orchestration ----

// Constraint ② lives here: an atomic per-purchase claim so a retry can never mint a second
// authorization for the same intent. The real guard is D1-backed; tests use an in-memory one.
export interface BuyGuard {
  // Approve the exact authorization about to be signed (constraint ①). Refuse -> nothing signs.
  approve(input: {
    purchaseKey: string;
    network: string;
    asset: string;
    resourceUrl: string;
    auth: Eip3009Authorization;
  }): Promise<{ approved: boolean; reason?: string }>;
  // Atomically claim the purchase slot (constraint ②). proceed=false -> already in flight/settled.
  begin(input: { purchaseKey: string; auth: Eip3009Authorization }): Promise<{ proceed: boolean; reason?: string }>;
  // Persist the outcome for later reconciliation / evidence.
  record(input: { purchaseKey: string; auth: Eip3009Authorization; receipt: SettlementResponse | null; resourceOk: boolean }): Promise<void>;
}

export interface BuyOptions {
  signer: BuySigner;
  policy: BuyPolicy;
  guard: BuyGuard;
  purchaseKey: string; // idempotency key tied to the intent (e.g. mission id), NOT the nonce
  method?: "GET" | "POST";
  body?: unknown;
  // When set, sign THIS pre-approved authorization instead of minting a fresh one. The
  // prepare -> approve -> execute flow uses it so the creator approves the exact authorization
  // (including nonce) that will be signed. It must still match the seller's live requirement.
  preparedAuth?: Eip3009Authorization;
  fetchImpl?: FetchLike;
  nowSeconds?: () => number;
  nonce?: () => Hex;
}

export interface BuyResult {
  ok: boolean;
  reason?: string;
  status?: number;
  transaction?: string;
  network?: string;
  payer?: string;
  authorization?: Eip3009Authorization;
  resource?: unknown;
}

const doFetch = (o: BuyOptions): FetchLike => o.fetchImpl ?? ((u, init) => fetch(u, init as RequestInit) as unknown as Promise<HttpResponseLike>);

export async function buyResource(url: string, o: BuyOptions): Promise<BuyResult> {
  const f = doFetch(o);
  const method = o.method ?? "GET";
  const reqBody = o.body === undefined ? undefined : JSON.stringify(o.body);
  const now = (o.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const mkNonce = o.nonce ?? randomNonce;

  // 1. Unpaid request -> expect a 402 carrying the requirements.
  const first = await f(url, { method, headers: { accept: "application/json" }, body: reqBody });
  if (first.status === 200) {
    return { ok: true, reason: "resource free (no 402 challenge)", status: 200, resource: await first.json().catch(() => null) };
  }
  if (first.status !== 402) {
    return { ok: false, reason: `expected 402, got ${first.status}`, status: first.status };
  }
  const firstBody = await first.json().catch(() => null);
  const required = parsePaymentRequired(first, firstBody);
  if (!required) return { ok: false, reason: "402 without parseable payment requirements", status: 402 };

  // 2. Fail-closed selection of a requirement we are willing to sign.
  const sel = selectAccept(required.accepts, o.policy);
  if (!sel.accept || sel.chainId === undefined) return { ok: false, reason: sel.reason ?? "no signable requirement", status: 402 };
  const accept = sel.accept;

  // 3. Build the authorization to sign. Either a pre-approved one (prepare->approve->execute)
  // or a fresh single-use nonce. A prepared authorization must still match the seller's live
  // requirement, else the seller changed terms after approval and we refuse (fail-closed).
  let built: BuiltAuthorization;
  if (o.preparedAuth) {
    const pa = o.preparedAuth;
    if (!isAddress(pa.from) || pa.from.toLowerCase() !== o.signer.address.toLowerCase()) {
      return { ok: false, reason: "prepared authorization 'from' != signer address", status: 402 };
    }
    if (!isAddress(pa.to) || pa.to.toLowerCase() !== accept.payTo.toLowerCase()) {
      return { ok: false, reason: "seller payTo changed after approval; re-prepare", status: 402 };
    }
    if (!UINT_RE.test(pa.value) || pa.value !== accept.amount) {
      return { ok: false, reason: "seller amount changed after approval; re-prepare", status: 402 };
    }
    if (!isBytes32(pa.nonce)) return { ok: false, reason: "prepared nonce is not bytes32", status: 402 };
    const dm = eip712For(accept, sel.chainId, pa);
    built = { auth: pa, domain: dm.domain, message: dm.message };
  } else {
    built = buildAuthorization({
      accept,
      chainId: sel.chainId,
      from: o.signer.address,
      nonce: mkNonce(),
      nowSeconds: now,
      maxTimeoutSeconds: o.policy.maxTimeoutSeconds,
    });
  }

  // 4. Constraint ①: approval must lock THIS exact authorization, else nothing is signed.
  const approval = await o.guard.approve({
    purchaseKey: o.purchaseKey,
    network: accept.network,
    asset: accept.asset,
    resourceUrl: url,
    auth: built.auth,
  });
  if (!approval.approved) return { ok: false, reason: `not approved: ${approval.reason ?? "no approval"}`, authorization: built.auth };

  // 5. Constraint ②: atomic claim so a retry cannot mint a second authorization.
  const claim = await o.guard.begin({ purchaseKey: o.purchaseKey, auth: built.auth });
  if (!claim.proceed) return { ok: false, reason: `purchase slot not claimed: ${claim.reason ?? "in flight or settled"}`, authorization: built.auth };

  // 6. Sign the approved authorization (offline) and retry with the payment header.
  let signature: Hex;
  try {
    signature = await o.signer.signTypedData({
      domain: built.domain,
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: built.message,
    });
  } catch (e) {
    await o.guard.record({ purchaseKey: o.purchaseKey, auth: built.auth, receipt: null, resourceOk: false });
    return { ok: false, reason: `signing failed: ${(e as Error).message}`, authorization: built.auth };
  }

  const header = encodePaymentHeader(required.version, {
    resource: required.resource,
    accept,
    signature,
    auth: built.auth,
  });
  const second = await f(url, {
    method,
    headers: { accept: "application/json", [paymentHeaderName(required.version)]: header },
    body: reqBody,
  });
  const secondBody = await second.json().catch(() => null);
  const receipt = decodeSettlement(second, required.version);
  const resourceOk = second.status === 200 && (receipt?.success ?? false);

  // 7. Persist the outcome (settled tx, or the uncertain state for reconciliation).
  await o.guard.record({ purchaseKey: o.purchaseKey, auth: built.auth, receipt, resourceOk });

  if (!resourceOk) {
    return {
      ok: false,
      reason: receipt?.errorReason ? `settlement failed: ${receipt.errorReason}` : `paid request did not settle (status ${second.status})`,
      status: second.status,
      transaction: receipt?.transaction,
      network: accept.network,
      payer: receipt?.payer,
      authorization: built.auth,
      resource: secondBody,
    };
  }
  return {
    ok: true,
    status: second.status,
    transaction: receipt?.transaction,
    network: receipt?.network ?? accept.network,
    payer: receipt?.payer ?? o.signer.address,
    authorization: built.auth,
    resource: secondBody,
  };
}

// Convenience for reporting/caps: atomic USDC (6 decimals on Base and the Arc ERC-20) -> USD.
export function atomicToUsd(amountAtomic: bigint | string, decimals = 6): number {
  return Number(BigInt(amountAtomic)) / 10 ** decimals;
}
