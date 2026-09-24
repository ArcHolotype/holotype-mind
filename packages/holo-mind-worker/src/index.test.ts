// Integration tests for the mind worker's HTTP routing (index.ts) around the two payout rails:
// the seller-chosen rail at delivery (wallet -> vanilla, x402Endpoint -> x402) and the PUBLIC
// evidence pack that must identify an x402 settlement and carry its verifiable proof. No live
// network and no real money: a fake D1 backs the mission + purchase reads/writes these routes touch.

import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index";
import type { Env } from "./config";

const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const SELLER_EOA = "0x2222222222222222222222222222222222222222";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const NONCE = "0x" + "ab".repeat(32);

// Fake D1 covering exactly the statements these routes issue: getMission (SELECT first),
// setMissionDelivery / setMissionStatus (UPDATE run), getPurchaseByKey (SELECT first).
function fakeEnv(opts: {
  mission: Record<string, unknown>;
  purchase?: Record<string, unknown> | null;
}): Env {
  // Mutate the caller's object in place so a test can read back what a route wrote.
  const mission = opts.mission;
  const db = {
    prepare(sql: string) {
      let b: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          b = args;
          return stmt;
        },
        async first() {
          if (/SELECT \* FROM holo_missions WHERE id/.test(sql)) {
            return Number(b[0]) === mission.id ? { ...mission } : null;
          }
          if (/SELECT \* FROM holo_x402_purchases WHERE purchase_key/.test(sql)) {
            return opts.purchase && opts.purchase.purchase_key === b[0] ? { ...opts.purchase } : null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (/SET delivery = \?1/.test(sql)) {
            mission.delivery = b[0];
            mission.status = "submitted";
            return { meta: { changes: 1 } };
          }
          if (/SET status = \?1/.test(sql)) {
            mission.status = b[0];
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { DB: db } as unknown as Env;
}

function baseMission(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    ts: "2026-01-01T00:00:00.000Z",
    title: "test mission",
    description: "d",
    criteria: JSON.stringify(["one criterion"]),
    reward_cents: 50,
    chain: "arc",
    status: "claimed",
    claimant: "seller-agent",
    delivery: null,
    approval: null,
    tx_hash: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const post = (path: string, body: unknown) =>
  new Request("https://mind.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ---- delivery picks the rail; exactly one of recipient / x402Endpoint ----

test("delivery refuses both a wallet recipient and an x402 endpoint", async () => {
  const env = fakeEnv({ mission: baseMission() });
  const res = await worker.fetch(
    post("/missions/1/delivery", {
      summary: "s", artifact: "a", recipient: RECIPIENT, x402Endpoint: "https://seller.test/x", evidence: ["e"],
    }),
    env,
  );
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /not both/);
});

test("delivery refuses when neither a wallet nor an x402 endpoint is given", async () => {
  const env = fakeEnv({ mission: baseMission() });
  const res = await worker.fetch(
    post("/missions/1/delivery", { summary: "s", artifact: "a", evidence: ["e"] }),
    env,
  );
  assert.equal(res.status, 400);
});

test("delivery with an x402 endpoint goes straight to approval_pending and records rail=x402", async () => {
  const mission = baseMission();
  const env = fakeEnv({ mission });
  const res = await worker.fetch(
    post("/missions/1/delivery", {
      summary: "s", artifact: "a", x402Endpoint: "https://seller.test/x", evidence: ["e"],
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.status, "approval_pending");
  const stored = JSON.parse(String(mission.delivery));
  assert.equal(stored.rail, "x402");
  assert.equal(stored.x402Endpoint, "https://seller.test/x");
});

test("delivery with a wallet recipient records rail=vanilla", async () => {
  const mission = baseMission();
  const env = fakeEnv({ mission });
  const res = await worker.fetch(
    post("/missions/1/delivery", { summary: "s", artifact: "a", recipient: RECIPIENT, evidence: ["e"] }),
    env,
  );
  assert.equal(res.status, 200);
  const stored = JSON.parse(String(mission.delivery));
  assert.equal(stored.rail, "vanilla");
});

// ---- public evidence pack identifies + proves an x402 settlement ----

test("evidence marks an x402 settlement and carries the verifiable proof block", async () => {
  const env = fakeEnv({
    mission: baseMission({
      status: "completed",
      tx_hash: "0xsettled",
      delivery: JSON.stringify({ summary: "s", artifact: "a", x402Endpoint: "https://seller.test/x", rail: "x402", evidence: ["e"] }),
      approval: JSON.stringify({ by: "creator", at: "2026-01-01T00:00:00.000Z", rail: "x402", amountCents: 1, nonce: NONCE }),
    }),
    purchase: {
      purchase_key: "mission-1",
      network: "eip155:5042",
      asset: ARC_USDC,
      pay_to: SELLER_EOA,
      amount: "10000",
      nonce: NONCE,
      valid_after: 1000,
      valid_before: 1060,
      resource_url: "https://seller.test/x",
      status: "settled",
      approval: "{}",
      payer: "0xfd644825d074015bed978cb1472bb4b6c1145b06",
      tx_hash: "0xsettled",
      receipt: JSON.stringify({ success: true, transaction: "0xsettled", network: "eip155:5042" }),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });
  const res = await worker.fetch(new Request("https://mind.test/missions/1/evidence"), env);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.settlement.method, "x402");
  assert.equal(body.settlement.tx_hash, "0xsettled");
  assert.equal(body.delivery.rail, "x402");
  assert.ok(body.x402, "x402 proof block must be present");
  assert.equal(body.x402.method, "x402");
  assert.equal(body.x402.asset_transfer_method, "eip3009");
  assert.equal(body.x402.nonce, NONCE);
  assert.equal(body.x402.pay_to, SELLER_EOA);
  assert.equal(body.x402.amount_usd, 0.01);
  assert.equal(body.x402.tx_hash, "0xsettled");
  // The event topic anyone can re-scan to verify the authorization was consumed on-chain.
  assert.equal(body.x402.authorization_used_topic, "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5");
});

test("evidence for a vanilla settlement has no x402 block and method=transfer", async () => {
  const env = fakeEnv({
    mission: baseMission({
      status: "completed",
      tx_hash: "0xtransfer",
      delivery: JSON.stringify({ summary: "s", artifact: "a", recipient: RECIPIENT, rail: "vanilla", evidence: ["e"] }),
      approval: JSON.stringify({ by: "creator", at: "2026-01-01T00:00:00.000Z", amountCents: 50, recipient: RECIPIENT }),
    }),
    purchase: null,
  });
  const res = await worker.fetch(new Request("https://mind.test/missions/1/evidence"), env);
  const body = (await res.json()) as any;
  assert.equal(body.settlement.method, "transfer");
  assert.equal(body.settlement.recipient, RECIPIENT);
  assert.equal(body.x402, null);
});
