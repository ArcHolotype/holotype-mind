// Tests for the x402 buyer infrastructure (x402.ts). No live network and no real money:
// a mock 402 seller is driven through the injected FetchLike, an in-memory guard backs the
// two safety constraints, and signing uses a well-known Hardhat test key that controls no
// funds. The mock seller actually recovers the EIP-3009 signature and checks the payer, so
// the happy path proves the typed data is constructed correctly, not just that it round-trips.

import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  EIP3009_TYPES,
  authorizationMatchesLock,
  b64decodeJson,
  b64encodeJson,
  buildAuthorization,
  buyResource,
  defaultBuyPolicy,
  encodePaymentHeader,
  parsePaymentRequired,
  selectAccept,
  type AcceptEntry,
  type ApprovalLock,
  type BuyGuard,
  type BuyPolicy,
  type BuySigner,
  type HttpResponseLike,
  type FetchLike,
  type SettlementResponse,
} from "./x402";

// Well-known Hardhat/Anvil test vector — public, controls no real funds.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
const account = privateKeyToAccount(PK);
const PAYER = account.address;

// Arc mainnet USDC, verified read-only on-chain (chainId 5042, 6 decimals, EIP-3009 present,
// DOMAIN_SEPARATOR == the EIP-712 domain {name:"USDC",version:"2",chainId:5042,this contract}).
const ARC = "eip155:5042";
const BASE = "eip155:8453";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const SELLER = "0x2222222222222222222222222222222222222222";

const signer: BuySigner = {
  address: PAYER,
  // viem's signTypedData is generically typed; the request we build is a valid EIP-712 call.
  signTypedData: (req) => account.signTypedData(req as never) as Promise<`0x${string}`>,
};

function res(status: number, headers: Record<string, string>, body: unknown): HttpResponseLike {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return { status, headers: { get: (n) => lower[n.toLowerCase()] ?? null }, json: async () => body };
}

function policy(over: Partial<BuyPolicy> = {}): BuyPolicy {
  return {
    allowNetworks: [ARC, BASE],
    allowAssets: { [ARC]: [ARC_USDC], [BASE]: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"] },
    maxAmountAtomic: 5_000_000n, // $5 at 6 decimals
    ...over,
  };
}

// An in-memory guard: approves everything and claims each purchase key once (constraint ②).
function memGuard(over: Partial<BuyGuard> = {}): BuyGuard & { claims: string[]; records: unknown[] } {
  const claimed = new Set<string>();
  const claims: string[] = [];
  const records: unknown[] = [];
  return {
    claims,
    records,
    approve: async () => ({ approved: true }),
    begin: async ({ purchaseKey }) => {
      claims.push(purchaseKey);
      if (claimed.has(purchaseKey)) return { proceed: false, reason: "already claimed" };
      claimed.add(purchaseKey);
      return { proceed: true };
    },
    record: async (r) => {
      records.push(r);
    },
    ...over,
  };
}

// A seller requirement object (V2 shape) the mock 402 seller advertises.
function requirement(over: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: ARC,
    asset: ARC_USDC,
    amount: "10000",
    payTo: SELLER,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...over,
  };
}

// Mock seller: 402 with PAYMENT-REQUIRED, then on a paid retry it RECOVERS the EIP-3009
// signature and only settles when it verifies to the advertised payer.
function mockSeller(opts: {
  req?: Record<string, unknown>;
  settle?: "success" | "failure";
  tx?: string;
  onPaid?: (info: { recovered: string; authorization: Record<string, string> }) => void;
}): FetchLike {
  const req = opts.req ?? requirement();
  return async (_url, init) => {
    const headers = init?.headers ?? {};
    const sig = headers["PAYMENT-SIGNATURE"];
    if (!sig) {
      const paymentRequired = {
        x402Version: 2,
        resource: { url: _url, description: "test", mimeType: "application/json" },
        accepts: [req],
      };
      return res(402, { "PAYMENT-REQUIRED": b64encodeJson(paymentRequired) }, {});
    }
    const decoded = b64decodeJson<{ payload: { signature: string; authorization: Record<string, string> } }>(sig);
    const auth = decoded!.payload.authorization;
    const recovered = await recoverTypedDataAddress({
      domain: { name: "USDC", version: "2", chainId: 5042, verifyingContract: req.asset as `0x${string}` },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
      signature: decoded!.payload.signature as `0x${string}`,
    } as never);
    opts.onPaid?.({ recovered, authorization: auth });
    const receipt: SettlementResponse =
      opts.settle === "failure"
        ? { success: false, errorReason: "insufficient_funds", transaction: "", network: req.network as string, payer: recovered }
        : { success: true, transaction: opts.tx ?? "0xabc123", network: req.network as string, payer: recovered };
    const status = receipt.success ? 200 : 402;
    return res(status, { "PAYMENT-RESPONSE": b64encodeJson(receipt) }, receipt.success ? { data: "paid resource" } : {});
  };
}

// ---- wire format ----

test("parsePaymentRequired decodes the spec V2 PAYMENT-REQUIRED literal", () => {
  // Verbatim base64 from the x402 v2 HTTP transport spec.
  const literal =
    "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19";
  const r = res(402, { "PAYMENT-REQUIRED": literal }, {});
  const parsed = parsePaymentRequired(r, {});
  assert.equal(parsed?.version, 2);
  assert.equal(parsed?.accepts.length, 1);
  const a = parsed!.accepts[0];
  assert.equal(a.network, "eip155:84532");
  assert.equal(a.amount, "10000");
  assert.equal(a.scheme, "exact");
  assert.equal(a.method, ""); // no assetTransferMethod -> defaults to eip3009 downstream
  assert.equal(a.gateway, false);
  assert.equal(a.domainName, "USDC");
  assert.equal(parsed?.resource?.url, "https://api.example.com/premium-data");
});

test("parsePaymentRequired decodes a V1 body", () => {
  const body = {
    x402Version: 1,
    error: "payment required",
    accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
  };
  const parsed = parsePaymentRequired(res(402, {}, body), body);
  assert.equal(parsed?.version, 1);
  assert.equal(parsed!.accepts[0].amount, "10000");
  assert.equal(parsed!.accepts[0].network, "base");
});

test("b64 json round-trips", () => {
  const obj = { a: 1, b: "x", c: { d: [1, 2, 3] } };
  assert.deepEqual(b64decodeJson(b64encodeJson(obj)), obj);
});

// ---- fail-closed selection ----

function entry(over: Partial<AcceptEntry> = {}): AcceptEntry {
  return {
    scheme: "exact",
    network: ARC,
    asset: ARC_USDC as `0x${string}`,
    amount: "10000",
    payTo: SELLER as `0x${string}`,
    maxTimeoutSeconds: 60,
    method: "",
    domainName: "USDC",
    domainVersion: "2",
    gateway: false,
    raw: {},
    ...over,
  };
}

test("selectAccept accepts a compliant eip3009 requirement", () => {
  const sel = selectAccept([entry()], policy());
  assert.ok(sel.accept);
  assert.equal(sel.chainId, 5042);
});

test("selectAccept is fail-closed", () => {
  assert.match(selectAccept([entry({ gateway: true })], policy()).reason ?? "", /Gateway/);
  assert.match(selectAccept([entry({ method: "permit2" })], policy()).reason ?? "", /permit2/);
  assert.match(selectAccept([entry({ method: "erc7710" })], policy()).reason ?? "", /erc7710/);
  assert.match(selectAccept([entry({ scheme: "upto" })], policy()).reason ?? "", /exact/);
  assert.match(selectAccept([entry({ network: "eip155:1" })], policy()).reason ?? "", /network/);
  assert.match(selectAccept([entry({ asset: "0x9999999999999999999999999999999999999999" as `0x${string}` })], policy()).reason ?? "", /asset/);
  assert.match(selectAccept([entry({ amount: "999999999" })], policy()).reason ?? "", /cap/);
  assert.match(selectAccept([], policy()).reason ?? "", /no payment requirements/);
});

// ---- authorization + approval lock (constraint ①) ----

test("buildAuthorization sets window, value, nonce", () => {
  const built = buildAuthorization({
    accept: entry({ maxTimeoutSeconds: 60 }),
    chainId: 5042,
    from: PAYER,
    nonce: "0x" + "11".repeat(32) as `0x${string}`,
    nowSeconds: 1_000_000,
    maxTimeoutSeconds: 30,
  });
  assert.equal(built.auth.value, "10000");
  assert.equal(built.auth.validAfter, "1000000");
  assert.equal(built.auth.validBefore, "1000030"); // clamped to the policy cap, not the seller's 60
  assert.equal(built.message.value, 10000n);
  assert.equal(built.domain.verifyingContract, ARC_USDC);
  assert.equal(built.domain.chainId, 5042);
});

test("authorizationMatchesLock enforces the exact approved params", () => {
  const auth = { from: PAYER, to: SELLER as `0x${string}`, value: "10000", validAfter: "1", validBefore: "2", nonce: ("0x" + "aa".repeat(32)) as `0x${string}` };
  const ctx = { network: ARC, asset: ARC_USDC };
  const lock: ApprovalLock = { from: PAYER, to: SELLER, value: "10000", validAfter: "1", validBefore: "2", nonce: "0x" + "aa".repeat(32), network: ARC, asset: ARC_USDC };
  assert.equal(authorizationMatchesLock(auth, ctx, lock), true);
  assert.equal(authorizationMatchesLock({ ...auth, value: "99999" }, ctx, lock), false); // amount changed
  assert.equal(authorizationMatchesLock({ ...auth, to: PAYER }, ctx, lock), false); // recipient changed
  assert.equal(authorizationMatchesLock(auth, { ...ctx, network: BASE }, lock), false); // chain changed
});

test("encodePaymentHeader produces a V2 payload the seller can decode", () => {
  const accept = entry();
  const auth = { from: PAYER, to: SELLER as `0x${string}`, value: "10000", validAfter: "1", validBefore: "2", nonce: ("0x" + "aa".repeat(32)) as `0x${string}` };
  const header = encodePaymentHeader(2, { accept, signature: "0xdead" as `0x${string}`, auth });
  const decoded = b64decodeJson<{ x402Version: number; accepted: unknown; payload: { signature: string } }>(header);
  assert.equal(decoded?.x402Version, 2);
  assert.equal(decoded?.payload.signature, "0xdead");
  assert.deepEqual(decoded?.accepted, accept.raw);
});

// ---- orchestration ----

test("buyResource completes a purchase and the seller verifies the EIP-3009 signature", async () => {
  const seen: { recovered?: string } = {};
  const guard = memGuard();
  const out = await buyResource("https://seller.test/api/premium", {
    signer,
    policy: policy(),
    guard,
    purchaseKey: "mission-42",
    fetchImpl: mockSeller({ tx: "0xsettled", onPaid: (i) => { seen.recovered = i.recovered; } }),
    nowSeconds: () => 1_700_000_000,
    nonce: () => ("0x" + "ab".repeat(32)) as `0x${string}`,
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.transaction, "0xsettled");
  assert.equal(out.network, ARC);
  // The seller recovered the signer from the typed data -> the authorization is a valid EIP-3009 sig.
  assert.equal(seen.recovered?.toLowerCase(), PAYER.toLowerCase());
  assert.equal(guard.records.length, 1);
  assert.equal((guard.records[0] as { receipt: SettlementResponse }).receipt.success, true);
});

test("buyResource signs nothing when the guard does not approve (constraint ①)", async () => {
  let signed = 0;
  const spySigner: BuySigner = { address: PAYER, signTypedData: async (r) => { signed++; return signer.signTypedData(r); } };
  const out = await buyResource("https://seller.test/x", {
    signer: spySigner,
    policy: policy(),
    guard: memGuard({ approve: async () => ({ approved: false, reason: "no fresh approval" }) }),
    purchaseKey: "k1",
    fetchImpl: mockSeller({}),
  });
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /not approved/);
  assert.equal(signed, 0);
});

test("buyResource refuses a second authorization for the same purchase key (constraint ②)", async () => {
  let signed = 0;
  const spySigner: BuySigner = { address: PAYER, signTypedData: async (r) => { signed++; return signer.signTypedData(r); } };
  const guard = memGuard();
  const first = await buyResource("https://seller.test/x", { signer: spySigner, policy: policy(), guard, purchaseKey: "dup", fetchImpl: mockSeller({}), nowSeconds: () => 1, nonce: () => ("0x" + "01".repeat(32)) as `0x${string}` });
  assert.equal(first.ok, true, first.reason);
  const second = await buyResource("https://seller.test/x", { signer: spySigner, policy: policy(), guard, purchaseKey: "dup", fetchImpl: mockSeller({}), nowSeconds: () => 2, nonce: () => ("0x" + "02".repeat(32)) as `0x${string}` });
  assert.equal(second.ok, false);
  assert.match(second.reason ?? "", /not claimed/);
  assert.equal(signed, 1); // only the first purchase ever signed
});

test("buyResource surfaces a settlement failure without claiming success", async () => {
  const guard = memGuard();
  const out = await buyResource("https://seller.test/x", {
    signer,
    policy: policy(),
    guard,
    purchaseKey: "fail",
    fetchImpl: mockSeller({ settle: "failure" }),
  });
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /insufficient_funds/);
  assert.equal((guard.records[0] as { receipt: SettlementResponse }).receipt.success, false);
});

test("buyResource rejects a seller whose asset is not on the allowlist", async () => {
  const out = await buyResource("https://seller.test/x", {
    signer,
    policy: policy(),
    guard: memGuard(),
    purchaseKey: "bad-asset",
    fetchImpl: mockSeller({ req: requirement({ asset: "0x9999999999999999999999999999999999999999" }) }),
  });
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /asset/);
});

test("defaultBuyPolicy carries the verified Arc mainnet USDC asset", () => {
  const p = defaultBuyPolicy({ maxAmountAtomic: 5_000_000n });
  assert.deepEqual(p.allowNetworks, [ARC, BASE]);
  assert.deepEqual(p.allowAssets[ARC], [ARC_USDC]);
  assert.equal(selectAccept([entry()], p).accept?.asset, ARC_USDC);
});

test("buildAuthorization pins the verified Arc domain regardless of seller extra", () => {
  // A seller advertising a bogus EIP-712 domain name/version cannot steer the signature: for the
  // verified Arc USDC asset the domain is pinned to {name:"USDC",version:"2"} (matches on-chain).
  const built = buildAuthorization({
    accept: entry({ domainName: "EvilToken", domainVersion: "9" }),
    chainId: 5042,
    from: PAYER,
    nonce: ("0x" + "cc".repeat(32)) as `0x${string}`,
    nowSeconds: 1_000,
  });
  assert.equal(built.domain.name, "USDC");
  assert.equal(built.domain.version, "2");
  assert.equal(built.domain.verifyingContract, ARC_USDC);
});
