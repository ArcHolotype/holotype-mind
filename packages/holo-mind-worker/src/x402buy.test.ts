// Tests for the x402 BUYER rail wiring (x402buy.ts): prepare (review card, no money) + pay
// (creator PAY NOW -> sign + settle). No live network and no real money: an in-memory fake D1
// backs the purchases table, the seller is an injected FetchLike, globalThis.fetch is stubbed
// for the read-only EOA (eth_getCode) check, and signing uses a well-known Hardhat test key.

import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import type { Env, RuntimeConfig } from "./config";
import { executeX402Purchase, getOrPrepareX402Purchase, prepareX402Purchase, x402BuyPolicy } from "./x402buy";
import { getPurchaseByKey, type X402PurchaseRow } from "./x402guard";
import { ARC_MAINNET, type FetchLike, type HttpResponseLike } from "./x402";

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
const account = privateKeyToAccount(PK);
const PAYER = account.address;
const ARC = ARC_MAINNET; // eip155:5042
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const SELLER_EOA = "0x2222222222222222222222222222222222222222"; // payee with no code (a wallet)
const NONCE = ("0x" + "ab".repeat(32)) as `0x${string}`;

// $1/purchase cap, 5/day. amount "10000" atomic = 0.01 USDC = $0.01 (well within cap).
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    walletKey: PK,
    publicWallet: PAYER.toLowerCase(),
    arcRpcUrls: ["https://rpc.test/arc"],
    baseRpcUrls: ["https://rpc.test/base"],
    x402MaxPerPurchaseCents: 100,
    x402MaxPerDay: 5,
    x402MaxTimeoutSeconds: 300,
    ...over,
  } as unknown as RuntimeConfig;
}

// In-memory fake D1 for the holo_x402_purchases statements x402guard.ts + x402buy.ts issue.
function fakeD1() {
  const rows = new Map<string, X402PurchaseRow>();
  let nextId = 1;
  const committed = new Set(["approved", "in_flight", "settled", "uncertain"]);
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
          if (/SELECT COUNT\(\*\) AS c FROM holo_x402_purchases/.test(sql)) {
            const prefix = String(b[0]).replace(/%$/, "");
            let c = 0;
            for (const r of rows.values()) {
              if (r.created_at.startsWith(prefix) && committed.has(r.status)) c++;
            }
            return { c };
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
          if (/DELETE FROM holo_x402_purchases/.test(sql)) {
            const key = b[0] as string;
            const r = rows.get(key);
            if (r && r.status === "failed") { rows.delete(key); return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as Env["DB"], rows };
}

// A seller that challenges with a 402 (exact/eip3009, Arc USDC) and settles on the paid retry.
function mockSeller(opts: { amount?: string; payTo?: string; maxTimeoutSeconds?: number } = {}): FetchLike {
  const amount = opts.amount ?? "10000";
  const payTo = opts.payTo ?? SELLER_EOA;
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? 60;
  const req = { scheme: "exact", network: ARC, asset: ARC_USDC, amount, payTo, maxTimeoutSeconds, extra: { name: "USDC", version: "2" } };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  const res = (status: number, headers: Record<string, string>, body: unknown): HttpResponseLike => {
    const lower: Record<string, string> = {};
    for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
    return { status, headers: { get: (n) => lower[n.toLowerCase()] ?? null }, json: async () => body };
  };
  return async (url, init) => {
    const headers = init?.headers ?? {};
    if (!headers["PAYMENT-SIGNATURE"]) {
      return res(402, { "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: { url, description: "d", mimeType: "application/json" }, accepts: [req] }) }, {});
    }
    return res(200, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xsettled", network: ARC, payer: PAYER }) }, { data: "ok" });
  };
}

// Stub globalThis.fetch for the read-only eth_getCode (EOA) check. code "0x" = a wallet.
function eoaStub(code: string) {
  return async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}");
    const payload =
      body.method === "eth_getCode"
        ? { jsonrpc: "2.0", id: body.id ?? 1, result: code }
        : { jsonrpc: "2.0", id: body.id ?? 1, error: { message: `unexpected ${body.method}` } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
}
const realFetch = globalThis.fetch;
function withFetch(stub: (...a: never[]) => unknown, fn: () => Promise<void>) {
  return async () => {
    globalThis.fetch = stub as typeof globalThis.fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
  };
}

const NOW = 1000;
const now = () => NOW;
const fixedNonce = () => NONCE;

// ---- x402BuyPolicy ----

test("x402BuyPolicy derives the atomic cap from the cents cap ($1 -> 1e6 atomic)", () => {
  const p = x402BuyPolicy(cfg());
  assert.equal(p.maxAmountAtomic, 1_000_000n);
  assert.deepEqual(p.allowNetworks, [ARC_MAINNET, "eip155:8453"]);
});

// ---- prepare (review card, no money) ----

test("prepare builds a card and stores a 'prepared' row for an EOA payee", async () => {
  const { db, rows } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    const r = await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x",
      purchaseKey: "k1",
      fetchImpl: mockSeller(),
      nowSeconds: now,
      nonce: fixedNonce,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.card?.amountUsd, 0.01);
    assert.equal(r.card?.payTo, SELLER_EOA);
    assert.equal(r.card?.validBefore, NOW + 60); // seller bounds the window at 60s
  })();
  assert.equal(rows.get("k1")?.status, "prepared");
  assert.equal(rows.get("k1")?.payer, PAYER.toLowerCase());
});

test("prepare ACCEPTS a contract payee (x402 settles as an ERC-20 transfer; no EOA-only rule)", async () => {
  // Unlike the vanilla rail, an x402 settlement is a USDC transferWithAuthorization: the token
  // contract credits payTo and runs no code there, so a smart-contract/Gateway payee is allowed.
  const { db, rows } = fakeD1();
  const r = await prepareX402Purchase({ DB: db } as Env, cfg(), {
    url: "https://seller.test/x",
    purchaseKey: "k2",
    fetchImpl: mockSeller(),
    nowSeconds: now,
    nonce: fixedNonce,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(rows.get("k2")?.status, "prepared");
});

test("prepare refuses an amount over the per-purchase cap", async () => {
  const { db } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    const r = await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x",
      purchaseKey: "k3",
      fetchImpl: mockSeller({ amount: "2000000" }), // $2 > $1 cap
      nowSeconds: now,
      nonce: fixedNonce,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /exceeds cap/);
  })();
});

test("prepare refuses a non-402 response (nothing to buy)", async () => {
  const { db } = fakeD1();
  const free: FetchLike = async () => ({ status: 200, headers: { get: () => null }, json: async () => ({}) });
  await withFetch(eoaStub("0x"), async () => {
    const r = await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x",
      purchaseKey: "k4",
      fetchImpl: free,
      nowSeconds: now,
      nonce: fixedNonce,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /free|402/);
  })();
});

test("prepare refuses a second live purchase for the same key", async () => {
  const { db } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    const first = await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "k5", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    assert.equal(first.ok, true, first.reason);
    const second = await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "k5", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    assert.equal(second.ok, false);
    assert.match(second.reason ?? "", /already exists/);
  })();
});

// ---- pay (creator PAY NOW -> sign + settle) ----

test("pay settles a prepared purchase end to end (prepared -> approved -> settled)", async () => {
  const { db, rows } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    const p = await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "pay1", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    assert.equal(p.ok, true, p.reason);
    const r = await executeX402Purchase({ DB: db } as Env, cfg(), "pay1", {
      fetchImpl: mockSeller(), nowSeconds: now,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.transaction, "0xsettled");
    assert.equal(r.status, "settled");
  })();
  assert.equal(rows.get("pay1")?.status, "settled");
  assert.equal(rows.get("pay1")?.tx_hash, "0xsettled");
});

test("pay refuses once the authorization window expired (re-prepare needed)", async () => {
  const { db, rows } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    const p = await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "pay3", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    assert.equal(p.ok, true, p.reason);
    const r = await executeX402Purchase({ DB: db } as Env, cfg(), "pay3", {
      fetchImpl: mockSeller(), nowSeconds: () => NOW + 600, // past validBefore (NOW+60)
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /expired/);
  })();
  assert.notEqual(rows.get("pay3")?.status, "settled");
});

test("pay refuses when the wallet key does not control the configured address", async () => {
  const { db } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    const p = await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "pay4", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    assert.equal(p.ok, true, p.reason);
    // Mis-set public wallet: the armed key no longer derives to it -> integrity refuses.
    const r = await executeX402Purchase({ DB: db } as Env, cfg({ publicWallet: "0xdead000000000000000000000000000000000000" }), "pay4", {
      fetchImpl: mockSeller(), nowSeconds: now,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /integrity/i);
  })();
});

test("pay enforces the daily cap on committed purchases", async () => {
  const { db, rows } = fakeD1();
  const c = cfg({ x402MaxPerDay: 1 });
  await withFetch(eoaStub("0x"), async () => {
    // First purchase settles -> counts as committed today.
    const p1 = await prepareX402Purchase({ DB: db } as Env, c, {
      url: "https://seller.test/x", purchaseKey: "d1", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    assert.equal(p1.ok, true, p1.reason);
    const e1 = await executeX402Purchase({ DB: db } as Env, c, "d1", { fetchImpl: mockSeller(), nowSeconds: now });
    assert.equal(e1.ok, true, e1.reason);
    // Second purchase: prepare is refused because d1 is already committed today (cap=1).
    const p2 = await prepareX402Purchase({ DB: db } as Env, c, {
      url: "https://seller.test/x",
      purchaseKey: "d2",
      fetchImpl: mockSeller(),
      nowSeconds: now,
      nonce: () => ("0x" + "cd".repeat(32)) as `0x${string}`,
    });
    assert.equal(p2.ok, false);
    assert.match(p2.reason ?? "", /daily cap/);
  })();
  assert.equal(rows.get("d2"), undefined);
});

test("getPurchaseByKey reflects the settled state after pay", async () => {
  const { db } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "g1", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    await executeX402Purchase({ DB: db } as Env, cfg(), "g1", { fetchImpl: mockSeller(), nowSeconds: now });
  })();
  const row = await getPurchaseByKey(db, "g1");
  assert.equal(row?.status, "settled");
  assert.equal(row?.tx_hash, "0xsettled");
});

// ---- mission reward bound (maxAmountCents tightens, never raises, the cap) ----

test("prepare refuses a seller price above the mission reward even when under the global $1 cap", async () => {
  const { db, rows } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    // Mission reward 50c ($0.50); seller asks 800000 atomic = $0.80 (under the $1 global cap).
    const r = await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x",
      purchaseKey: "m-reward",
      maxAmountCents: 50,
      fetchImpl: mockSeller({ amount: "800000" }),
      nowSeconds: now,
      nonce: fixedNonce,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /exceeds cap/);
  })();
  assert.equal(rows.has("m-reward"), false);
});

test("prepare accepts a seller price at or below the mission reward", async () => {
  const { db } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    const r = await prepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x",
      purchaseKey: "m-ok",
      maxAmountCents: 50,
      fetchImpl: mockSeller({ amount: "10000" }), // $0.01 <= $0.50 reward
      nowSeconds: now,
      nonce: fixedNonce,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.card?.amountUsd, 0.01);
  })();
});

// ---- getOrPrepare (idempotent prepare for the mission PAY NOW button) ----

test("getOrPrepare returns the existing card on a re-click without re-fetching", async () => {
  const { db } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    const first = await getOrPrepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "idem", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    assert.equal(first.ok, true, first.reason);
    // Second call: a seller that would 500 if fetched — proves no re-fetch happens.
    const boom: FetchLike = async () => { throw new Error("should not fetch"); };
    const second = await getOrPrepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "idem", fetchImpl: boom, nowSeconds: now, nonce: fixedNonce,
    });
    assert.equal(second.ok, true);
    assert.equal(second.card?.purchaseKey, "idem");
    assert.equal(second.card?.amountUsd, first.card?.amountUsd);
  })();
});

test("getOrPrepare refuses to re-prepare a settled purchase", async () => {
  const { db } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    await getOrPrepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "set", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    await executeX402Purchase({ DB: db } as Env, cfg(), "set", { fetchImpl: mockSeller(), nowSeconds: now });
    const again = await getOrPrepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "set", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    assert.equal(again.ok, false);
    assert.match(again.reason ?? "", /settled/);
  })();
});

test("getOrPrepare re-prepares a row that expired to failed", async () => {
  const { db, rows } = fakeD1();
  await withFetch(eoaStub("0x"), async () => {
    await getOrPrepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "exp", fetchImpl: mockSeller(), nowSeconds: now, nonce: fixedNonce,
    });
    // Force the row to failed (as reconcile would after an expired unsettled authorization).
    rows.get("exp")!.status = "failed";
    const re = await getOrPrepareX402Purchase({ DB: db } as Env, cfg(), {
      url: "https://seller.test/x", purchaseKey: "exp", fetchImpl: mockSeller(), nowSeconds: now, nonce: () => ("0x" + "cd".repeat(32)) as `0x${string}`,
    });
    assert.equal(re.ok, true, re.reason);
    assert.equal(rows.get("exp")?.status, "prepared");
  })();
});

