// Tests for the D1-backed x402 buyer guard + reconciliation (x402guard.ts). No live network and
// no real money: an in-memory fake D1 backs the purchases table and globalThis.fetch is stubbed
// for the read-only chain scan. Signing (integration test) uses a well-known Hardhat test key.

import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { Env, RuntimeConfig } from "./config";
import {
  approvePurchase,
  createD1BuyGuard,
  findAuthorizationUsed,
  getPurchaseByKey,
  preparePurchase,
  reconcileX402Purchase,
  type X402PurchaseRow,
} from "./x402guard";
import { ARC_MAINNET, buyResource, type BuySigner, type Eip3009Authorization, type FetchLike, type HttpResponseLike } from "./x402";

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
const account = privateKeyToAccount(PK);
const PAYER = account.address;
const ARC = ARC_MAINNET; // eip155:5042
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const SELLER = "0x2222222222222222222222222222222222222222";
const NONCE = ("0x" + "ab".repeat(32)) as `0x${string}`;

const signer: BuySigner = { address: PAYER, signTypedData: (r) => account.signTypedData(r as never) as Promise<`0x${string}`> };

function cfg(): RuntimeConfig {
  return { arcRpcUrls: ["https://rpc.test/arc"], baseRpcUrls: ["https://rpc.test/base"], publicWallet: PAYER } as unknown as RuntimeConfig;
}

function auth(over: Partial<Eip3009Authorization> = {}): Eip3009Authorization {
  return { from: PAYER, to: SELLER as `0x${string}`, value: "10000", validAfter: "1000", validBefore: "1060", nonce: NONCE, ...over };
}

// In-memory fake D1 for the holo_x402_purchases statements x402guard.ts issues.
function fakeD1() {
  const rows = new Map<string, X402PurchaseRow>();
  let nextId = 1;
  const db = {
    prepare(sql: string) {
      let b: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          b = args;
          return stmt;
        },
        async first() {
          if (/SELECT \* FROM holo_x402_purchases WHERE purchase_key/.test(sql)) {
            const r = rows.get(b[0] as string);
            return r ? { ...r } : null;
          }
          return null;
        },
        async all() {
          return { results: [...rows.values()] };
        },
        async run() {
          if (/INSERT INTO holo_x402_purchases/.test(sql)) {
            const [key, network, asset, pay_to, amount, nonce, va, vb, url, payer, created, updated] = b as [
              string, string, string, string, string, string, number, number, string, string, string, string,
            ];
            if (rows.has(key)) return { meta: { changes: 0, last_row_id: 0 } };
            const id = nextId++;
            rows.set(key, {
              id, purchase_key: key, network, asset, pay_to, amount, nonce, valid_after: va, valid_before: vb,
              resource_url: url, status: "prepared", approval: null, payer, tx_hash: null, receipt: null,
              created_at: created, updated_at: updated,
            });
            return { meta: { changes: 1, last_row_id: id } };
          }
          if (/SET status = 'approved'/.test(sql)) {
            const [approval, updated, key] = b as [string, string, string];
            const r = rows.get(key);
            if (r && r.status === "prepared") { r.status = "approved"; r.approval = approval; r.updated_at = updated; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (/SET status = 'in_flight'/.test(sql)) {
            const [updated, key, nonce] = b as [string, string, string];
            const r = rows.get(key);
            if (r && r.status === "approved" && r.tx_hash == null && r.nonce === nonce) { r.status = "in_flight"; r.updated_at = updated; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (/tx_hash = COALESCE/.test(sql)) {
            const [status, tx, payer, receipt, updated, key] = b as [string, string | null, string, string | null, string, string];
            const r = rows.get(key);
            if (r) { r.status = status; if (tx != null) r.tx_hash = tx; r.payer = payer; r.receipt = receipt; r.updated_at = updated; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (/SET status = 'settled'/.test(sql)) {
            const [tx, updated, key] = b as [string, string, string];
            const r = rows.get(key);
            if (r) { r.status = "settled"; r.tx_hash = tx; r.updated_at = updated; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          if (/SET status = 'failed'/.test(sql)) {
            const [updated, key] = b as [string, string];
            const r = rows.get(key);
            if (r) { r.status = "failed"; r.updated_at = updated; }
            return { meta: { changes: r ? 1 : 0 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as Env["DB"], rows };
}

async function preparedApproved(db: Env["DB"], key: string, a: Eip3009Authorization = auth()) {
  await preparePurchase(db, { purchaseKey: key, network: ARC, asset: ARC_USDC, resourceUrl: "https://seller.test/x", payer: PAYER, auth: a });
  await approvePurchase(db, key, "creator");
  return a;
}

// JSON-RPC stub for the read-only AuthorizationUsed scan.
function rpcStub(results: Record<string, unknown>) {
  return async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    const has = Object.prototype.hasOwnProperty.call(results, body.method);
    const payload = has
      ? { jsonrpc: "2.0", id: body.id ?? 1, result: results[body.method] }
      : { jsonrpc: "2.0", id: body.id ?? 1, error: { message: `unexpected ${body.method}` } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
}
const realFetch = globalThis.fetch;
function withFetch(stub: (...a: never[]) => unknown, fn: () => Promise<void>) {
  return async () => {
    globalThis.fetch = stub as typeof globalThis.fetch;
    try { await fn(); } finally { globalThis.fetch = realFetch; }
  };
}

// ---- constraint ①: approval locks the exact authorization ----

test("guard.approve passes only for an approved row whose params match exactly", async () => {
  const { db } = fakeD1();
  const a = await preparedApproved(db, "k1");
  const guard = createD1BuyGuard(db);
  const ok = await guard.approve({ purchaseKey: "k1", network: ARC, asset: ARC_USDC, resourceUrl: "u", auth: a });
  assert.equal(ok.approved, true);
});

test("guard.approve refuses when the row is not approved yet", async () => {
  const { db } = fakeD1();
  const a = auth();
  await preparePurchase(db, { purchaseKey: "k2", network: ARC, asset: ARC_USDC, resourceUrl: "u", payer: PAYER, auth: a });
  const guard = createD1BuyGuard(db);
  const r = await guard.approve({ purchaseKey: "k2", network: ARC, asset: ARC_USDC, resourceUrl: "u", auth: a });
  assert.equal(r.approved, false);
  assert.match(r.reason ?? "", /not approved/);
});

test("guard.approve refuses any deviation from the approved params", async () => {
  const { db } = fakeD1();
  const a = await preparedApproved(db, "k3");
  const guard = createD1BuyGuard(db);
  const base = { purchaseKey: "k3", network: ARC, asset: ARC_USDC, resourceUrl: "u" };
  assert.equal((await guard.approve({ ...base, auth: auth({ value: "99999" }) })).approved, false); // amount changed
  assert.equal((await guard.approve({ ...base, auth: auth({ to: PAYER }) })).approved, false); // recipient changed
  assert.equal((await guard.approve({ ...base, auth: auth({ nonce: ("0x" + "cd".repeat(32)) as `0x${string}` }) })).approved, false); // nonce changed
  assert.equal((await guard.approve({ ...base, network: "eip155:8453", auth: a })).approved, false); // chain changed
});

// ---- constraint ②: atomic single claim (no double-pay) ----

test("guard.begin claims once; a second claim for the same key is refused", async () => {
  const { db } = fakeD1();
  const a = await preparedApproved(db, "k4");
  const guard = createD1BuyGuard(db);
  const first = await guard.begin({ purchaseKey: "k4", auth: a });
  const second = await guard.begin({ purchaseKey: "k4", auth: a });
  assert.equal(first.proceed, true);
  assert.equal(second.proceed, false);
  assert.match(second.reason ?? "", /in flight or settled/);
});

test("guard.begin refuses a nonce that does not match the approved row", async () => {
  const { db } = fakeD1();
  await preparedApproved(db, "k5");
  const guard = createD1BuyGuard(db);
  const r = await guard.begin({ purchaseKey: "k5", auth: auth({ nonce: ("0x" + "ee".repeat(32)) as `0x${string}` }) });
  assert.equal(r.proceed, false);
});

// ---- record + reconcile ----

test("record persists a settlement (success) with its tx hash", async () => {
  const { db, rows } = fakeD1();
  const a = await preparedApproved(db, "k6");
  const guard = createD1BuyGuard(db);
  await guard.begin({ purchaseKey: "k6", auth: a });
  await guard.record({ purchaseKey: "k6", auth: a, receipt: { success: true, transaction: "0xsettled", network: ARC, payer: PAYER }, resourceOk: true });
  assert.equal(rows.get("k6")?.status, "settled");
  assert.equal(rows.get("k6")?.tx_hash, "0xsettled");
});

test("record parks a missing/failed receipt as uncertain (never silently failed)", async () => {
  const { db, rows } = fakeD1();
  const a = await preparedApproved(db, "k7");
  const guard = createD1BuyGuard(db);
  await guard.begin({ purchaseKey: "k7", auth: a });
  await guard.record({ purchaseKey: "k7", auth: a, receipt: null, resourceOk: false });
  assert.equal(rows.get("k7")?.status, "uncertain");
  assert.equal(rows.get("k7")?.tx_hash, null);
});

test("reconcile marks settled when AuthorizationUsed is found on-chain", async () => {
  const { db, rows } = fakeD1();
  const a = await preparedApproved(db, "k8");
  const guard = createD1BuyGuard(db);
  await guard.begin({ purchaseKey: "k8", auth: a });
  await guard.record({ purchaseKey: "k8", auth: a, receipt: null, resourceOk: false });
  await withFetch(rpcStub({ eth_blockNumber: "0x100", eth_getLogs: [{ transactionHash: "0xfound", blockNumber: "0xff" }] }), async () => {
    const r = await reconcileX402Purchase(db, cfg(), "k8", { nowSeconds: 1000 });
    assert.equal(r.ok, true);
    assert.equal(r.settled, true);
    assert.equal(r.txHash, "0xfound");
  })();
  assert.equal(rows.get("k8")?.status, "settled");
  assert.equal(rows.get("k8")?.tx_hash, "0xfound");
});

test("reconcile marks failed only once the authorization expired unsettled", async () => {
  const { db, rows } = fakeD1();
  const a = await preparedApproved(db, "k9");
  const guard = createD1BuyGuard(db);
  await guard.begin({ purchaseKey: "k9", auth: a });
  await guard.record({ purchaseKey: "k9", auth: a, receipt: null, resourceOk: false });
  await withFetch(rpcStub({ eth_blockNumber: "0x100", eth_getLogs: [] }), async () => {
    const r = await reconcileX402Purchase(db, cfg(), "k9", { nowSeconds: 2000 }); // past validBefore=1060
    assert.equal(r.ok, true);
    assert.equal(r.settled, false);
    assert.match(r.reason ?? "", /expired/);
  })();
  assert.equal(rows.get("k9")?.status, "failed");
});

test("reconcile keeps it uncertain while the authorization is still valid (no retry)", async () => {
  const { db, rows } = fakeD1();
  const a = await preparedApproved(db, "k10");
  const guard = createD1BuyGuard(db);
  await guard.begin({ purchaseKey: "k10", auth: a });
  await guard.record({ purchaseKey: "k10", auth: a, receipt: null, resourceOk: false });
  await withFetch(rpcStub({ eth_blockNumber: "0x100", eth_getLogs: [] }), async () => {
    const r = await reconcileX402Purchase(db, cfg(), "k10", { nowSeconds: 1000 }); // within window
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /do NOT retry/);
  })();
  assert.equal(rows.get("k10")?.status, "uncertain");
});

test("findAuthorizationUsed filters by the USDC contract, authorizer and nonce", async () => {
  let seenParams: unknown = null;
  const stub = async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x200" }), { status: 200 });
    seenParams = body.params?.[0];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ transactionHash: "0xt", blockNumber: "0x1ff" }] }), { status: 200 });
  };
  await withFetch(stub, async () => {
    const found = await findAuthorizationUsed(cfg(), ARC, ARC_USDC, PAYER, NONCE);
    assert.equal(found?.txHash, "0xt");
  })();
  const p = seenParams as { address: string; topics: string[] };
  assert.equal(p.address, ARC_USDC);
  assert.equal(p.topics[1], "0x" + PAYER.toLowerCase().replace("0x", "").padStart(64, "0"));
  assert.equal(p.topics[2], NONCE.toLowerCase());
});

// ---- integration: x402.ts buyer + D1 guard, prepared->approved->execute ----

function simpleSeller(): FetchLike {
  const req = { scheme: "exact", network: ARC, asset: ARC_USDC, amount: "10000", payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
  const res = (status: number, headers: Record<string, string>, body: unknown): HttpResponseLike => {
    const lower: Record<string, string> = {};
    for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
    return { status, headers: { get: (n) => lower[n.toLowerCase()] ?? null }, json: async () => body };
  };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  return async (url, init) => {
    const headers = init?.headers ?? {};
    if (!headers["PAYMENT-SIGNATURE"]) {
      return res(402, { "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: { url, description: "d", mimeType: "application/json" }, accepts: [req] }) }, {});
    }
    return res(200, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xintegrated", network: ARC, payer: PAYER }) }, { data: "ok" });
  };
}

test("buyResource with the D1 guard runs prepare->approve->execute and persists settled", async () => {
  const { db, rows } = fakeD1();
  const a = auth();
  await preparePurchase(db, { purchaseKey: "mission-99", network: ARC, asset: ARC_USDC, resourceUrl: "https://seller.test/x", payer: PAYER, auth: a });
  await approvePurchase(db, "mission-99", "creator");
  const guard = createD1BuyGuard(db);

  const out = await buyResource("https://seller.test/x", {
    signer,
    policy: { allowNetworks: [ARC], allowAssets: { [ARC]: [ARC_USDC] }, maxAmountAtomic: 5_000_000n },
    guard,
    purchaseKey: "mission-99",
    preparedAuth: a,
    fetchImpl: simpleSeller(),
    nowSeconds: () => 1000,
  });

  assert.equal(out.ok, true, out.reason);
  assert.equal(out.transaction, "0xintegrated");
  assert.equal(rows.get("mission-99")?.status, "settled");
  assert.equal(rows.get("mission-99")?.tx_hash, "0xintegrated");
  assert.equal((await getPurchaseByKey(db, "mission-99"))?.payer, PAYER);
});

test("buyResource with a preparedAuth the seller no longer honors is refused (terms changed)", async () => {
  const { db, rows } = fakeD1();
  const a = auth({ value: "10000" });
  await preparePurchase(db, { purchaseKey: "mission-100", network: ARC, asset: ARC_USDC, resourceUrl: "https://seller.test/x", payer: PAYER, auth: a });
  await approvePurchase(db, "mission-100", "creator");
  // Seller now advertises a higher price than the approved authorization.
  const priceySeller = simpleSeller();
  const raisedSeller: FetchLike = async (url, init) => {
    const headers = init?.headers ?? {};
    if (!headers["PAYMENT-SIGNATURE"]) {
      const req = { scheme: "exact", network: ARC, asset: ARC_USDC, amount: "99999", payTo: SELLER, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
      return { status: 402, headers: { get: (n: string) => (n.toLowerCase() === "payment-required" ? b64({ x402Version: 2, resource: { url }, accepts: [req] }) : null) }, json: async () => ({}) } as HttpResponseLike;
    }
    return priceySeller(url, init);
  };
  const out = await buyResource("https://seller.test/x", {
    signer,
    policy: { allowNetworks: [ARC], allowAssets: { [ARC]: [ARC_USDC] }, maxAmountAtomic: 5_000_000n },
    guard: createD1BuyGuard(db),
    purchaseKey: "mission-100",
    preparedAuth: a,
    fetchImpl: raisedSeller,
    nowSeconds: () => 1000,
  });
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /amount changed after approval/);
  assert.notEqual(rows.get("mission-100")?.status, "settled");
});
