// Tests for the payout rail (pay.ts) — the code that moves real money. Covers the
// guard chain (wallet integrity, locked approval params, atomic slot claim, refuse
// double-pay), the failure handling that parks a mission as payment_uncertain, and
// the creator-driven reconcile path. No live network: a fake D1 backs the store and
// globalThis.fetch is stubbed per test, so the chain send never actually broadcasts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnits } from "viem";
import { payApprovedMission, reconcileMission } from "./pay";
import type { MissionRow } from "./store";
import type { Env, RuntimeConfig } from "./config";

// Well-known Hardhat/Anvil test vectors — public, control no real funds.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WALLET = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // derives from PK
const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const OTHER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    walletKey: PK,
    publicWallet: WALLET,
    baseRpcUrls: ["https://rpc.test/base"],
    arcRpcUrls: ["https://rpc.test/arc"],
    arcNativeDecimals: 18,
    ...over,
  } as unknown as RuntimeConfig;
}

function mission(over: Partial<MissionRow> = {}): MissionRow {
  return {
    id: 1,
    ts: "2026-01-01T00:00:00.000Z",
    title: "test mission",
    description: "d",
    criteria: "[]",
    reward_cents: 50,
    chain: "arc",
    status: "approved",
    claimant: "agent",
    delivery: JSON.stringify({ recipient: RECIPIENT }),
    approval: JSON.stringify({ amountCents: 50, recipient: RECIPIENT }),
    tx_hash: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// In-memory stand-in for the D1 bindings pay.ts touches through store.ts:
// getMission (SELECT first), claimPaymentSlot (conditional UPDATE -> meta.changes),
// setMissionStatus / setMissionTxHash (UPDATE run). `claimChanges` forces the slot
// claim result so the losing side of a concurrent double-pay can be exercised.
function fakeD1(row: MissionRow | null, opts: { claimChanges?: number } = {}) {
  const state = { row: row ? { ...row } : null as MissionRow | null };
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first() {
          if (/SELECT \* FROM holo_missions WHERE id/.test(sql)) return state.row ? { ...state.row } : null;
          return null;
        },
        async all() {
          return { results: state.row ? [{ ...state.row }] : [] };
        },
        async run() {
          if (/SET status = 'paying'/.test(sql)) {
            const id = bound[1];
            const eligible =
              !!state.row && state.row.id === id && state.row.status === "approved" && state.row.tx_hash == null;
            const changes = opts.claimChanges !== undefined ? opts.claimChanges : eligible ? 1 : 0;
            if (changes === 1 && state.row) state.row.status = "paying";
            return { meta: { changes, last_row_id: id } };
          }
          if (/SET tx_hash = \?1/.test(sql)) {
            const [tx, id] = bound as [string, number];
            if (state.row && state.row.id === id) {
              state.row.tx_hash = tx;
              state.row.status = "completed";
            }
            return { meta: { changes: 1 } };
          }
          if (/SET status = \?1/.test(sql)) {
            const [status, id] = bound as [string, number];
            if (state.row && state.row.id === id) state.row.status = status;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } }; // touch / updated_at
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as Env["DB"], state };
}

const envOf = (db: unknown): Env => ({ DB: db }) as unknown as Env;

// Route JSON-RPC by method; anything unmapped returns a JSON-RPC error.
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
const failingRpc = async () => new Response("boom", { status: 500 });

const realFetch = globalThis.fetch;
function withFetch(stub: (...args: never[]) => unknown, fn: () => Promise<void>) {
  return async () => {
    globalThis.fetch = stub as typeof globalThis.fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
  };
}

// ---- guard chain: all of these return before any chain send ----

test("pay refuses when the armed key does not control the configured wallet", async () => {
  const { db } = fakeD1(mission());
  const r = await payApprovedMission(envOf(db), cfg({ publicWallet: OTHER }), 1);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /integrity/i);
});

test("pay refuses a missing mission", async () => {
  const { db } = fakeD1(null);
  const r = await payApprovedMission(envOf(db), cfg(), 1);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /no such mission/i);
});

test("pay refuses an already-settled mission (no double spend)", async () => {
  const { db } = fakeD1(mission({ tx_hash: "0xdeadbeef" }));
  const r = await payApprovedMission(envOf(db), cfg(), 1);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /already settled/i);
});

test("pay refuses a mission that is not approved", async () => {
  const { db } = fakeD1(mission({ status: "submitted" }));
  const r = await payApprovedMission(envOf(db), cfg(), 1);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /not approved/i);
});

test("pay refuses when approval or delivery record is missing", async () => {
  const { db } = fakeD1(mission({ approval: null }));
  const r = await payApprovedMission(envOf(db), cfg(), 1);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /missing approval or delivery/i);
});

test("pay refuses when the locked approval amount no longer matches the reward", async () => {
  const { db } = fakeD1(mission({ approval: JSON.stringify({ amountCents: 99, recipient: RECIPIENT }) }));
  const r = await payApprovedMission(envOf(db), cfg(), 1);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /amount != mission reward/i);
});

test("pay refuses when the locked approval recipient no longer matches the delivery", async () => {
  const { db } = fakeD1(mission({ approval: JSON.stringify({ amountCents: 50, recipient: OTHER }) }));
  const r = await payApprovedMission(envOf(db), cfg(), 1);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /recipient != delivery recipient/i);
});

test("pay refuses an invalid recipient address even when approval matches", async () => {
  const { db } = fakeD1(
    mission({
      delivery: JSON.stringify({ recipient: "not-an-address" }),
      approval: JSON.stringify({ amountCents: 50, recipient: "not-an-address" }),
    }),
  );
  const r = await payApprovedMission(envOf(db), cfg(), 1);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /not a valid address/i);
});

test("pay refuses the losing side of a concurrent claim (atomic slot guard)", async () => {
  // Mission looks payable, but the conditional UPDATE claims 0 rows because another
  // caller already flipped approved -> paying. The second send must not happen.
  const { db, state } = fakeD1(mission(), { claimChanges: 0 });
  const r = await payApprovedMission(envOf(db), cfg(), 1);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /slot not claimed/i);
  assert.equal(state.row?.status, "approved"); // untouched, never sent
});

// ---- failure handling: a send that cannot confirm parks as payment_uncertain ----

test(
  "pay parks the mission as payment_uncertain when the broadcast cannot complete",
  withFetch(failingRpc, async () => {
    // base chain: the decimals pre-flight RPC fails, so the send throws before broadcast.
    const { db, state } = fakeD1(mission({ chain: "base" }));
    const r = await payApprovedMission(envOf(db), cfg(), 1);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /payment_uncertain/i);
    assert.equal(state.row?.status, "payment_uncertain"); // never reverted to approved
  }),
);

// ---- reconcile: creator-driven recovery from payment_uncertain ----

test("reconcile refuses a mission that is not in payment_uncertain", async () => {
  const { db } = fakeD1(mission({ status: "approved" }));
  const r = await reconcileMission(envOf(db), cfg(), 1, {});
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /nothing to reconcile/i);
});

test(
  "reconcile records a supplied tx that verifies wallet -> recipient -> exact amount",
  withFetch(
    rpcStub({
      eth_getTransactionByHash: {
        from: WALLET,
        to: RECIPIENT,
        value: "0x" + parseUnits("0.5", 18).toString(16),
      },
    }),
    async () => {
      const { db, state } = fakeD1(mission({ status: "payment_uncertain", chain: "arc" }));
      const r = await reconcileMission(envOf(db), cfg(), 1, { txHash: "0xfeed" });
      assert.equal(r.ok, true);
      assert.equal(r.txHash, "0xfeed");
      assert.equal(state.row?.status, "completed");
      assert.equal(state.row?.tx_hash, "0xfeed");
    },
  ),
);

test(
  "reconcile rejects a supplied tx whose amount does not match",
  withFetch(
    rpcStub({ eth_getTransactionByHash: { from: WALLET, to: RECIPIENT, value: "0x1" } }),
    async () => {
      const { db, state } = fakeD1(mission({ status: "payment_uncertain", chain: "arc" }));
      const r = await reconcileMission(envOf(db), cfg(), 1, { txHash: "0xfeed" });
      assert.equal(r.ok, false);
      assert.match(r.reason ?? "", /does not match/i);
      assert.equal(state.row?.status, "payment_uncertain"); // stays parked
    },
  ),
);

test(
  "reconcile resets to approved when a scan finds no matching payment and reset is requested",
  withFetch(
    rpcStub({ eth_blockNumber: "0x10", eth_getLogs: [], eth_call: "0x6" }),
    async () => {
      const { db, state } = fakeD1(mission({ status: "payment_uncertain", chain: "base" }));
      const r = await reconcileMission(envOf(db), cfg(), 1, { reset: true });
      assert.equal(r.ok, true);
      assert.match(r.reason ?? "", /reset to approved/i);
      assert.equal(state.row?.status, "approved");
    },
  ),
);

test(
  "reconcile with no match and no reset leaves the mission parked and asks for a tx",
  withFetch(
    rpcStub({ eth_blockNumber: "0x10", eth_getLogs: [], eth_call: "0x6" }),
    async () => {
      const { db, state } = fakeD1(mission({ status: "payment_uncertain", chain: "base" }));
      const r = await reconcileMission(envOf(db), cfg(), 1, {});
      assert.equal(r.ok, false);
      assert.match(r.reason ?? "", /supply txHash/i);
      assert.equal(state.row?.status, "payment_uncertain");
    },
  ),
);
