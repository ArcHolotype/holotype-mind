import assert from "node:assert/strict";
import { test } from "node:test";
import {
  broadcastPublish,
  broadcastSettlement,
  cleanTweetText,
  composePublishTweet,
  composeSettlementTweet,
  maybeCadencePost,
} from "./broadcast";
import type { XPostStore } from "./xtweet";
import type { MissionRow } from "./store";
import type { Env } from "./config";

const WALLET = "0xfd644825d074015bed978cb1472bb4b6c1145b06";
const CA = "0xECa7C682fbb32EC4F1B3bBb28791Fe184D3552A8";
const FAKE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const NOW = new Date("2026-09-25T12:00:00.000Z");

function fakeEnv(over: Record<string, string> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    BODY_WORKER_URL: "https://body.example",
    MODEL: "test-model",
    HEARTBEAT_ENABLED: "false",
    DAILY_BUDGET_USD: "30",
    PER_BEAT_CAP_USD: "1",
    PER_CALL_FEE_USD: "0.001",
    PRIVATE_CONTEXT_N: "8",
    MODULATORY_TOPK: "10",
    X_BROADCAST_ENABLED: "true",
    X_POST_INTERVAL_HOURS: "3",
    X_POST_MAX_PER_DAY: "8",
    X_REPLY_MAX_PER_DAY: "12",
    X_OFFICIAL_HANDLE: "@ArcHolotype",
    OPENTWEET_API_KEY: "ot_test_key",
    OPENTWEET_BASE_URL: "https://mock.opentweet.local",
    PUBLIC_WALLET_ADDRESS: WALLET,
    TOKEN_CA: CA,
    BASE_RPC_URL: "https://mainnet.base.org",
    ARC_RPC_URL: "https://rpc.mainnet.arc.io",
    ...over,
  } as unknown as Env;
}

function fakeStore(seeds: { kind?: "post" | "reply"; text: string; postedAt: string }[] = []) {
  const rows: any[] = seeds.map((s) => ({
    kind: s.kind ?? "post",
    text: s.text,
    dedupHash: "seed",
    status: "sent",
    postedAt: s.postedAt,
  }));
  const store: XPostStore & { rows: any[] } = {
    rows,
    async countXSentSince(day, kind) {
      return rows.filter((r) => r.status === "sent" && r.kind === kind && r.postedAt.startsWith(day)).length;
    },
    async lastXSentAt(kind) {
      const sent = rows.filter((r) => r.status === "sent" && r.kind === kind);
      return sent.length ? sent[sent.length - 1].postedAt : null;
    },
    async recentXHashes() {
      return rows.filter((r) => r.status === "sent").map((r) => r.dedupHash);
    },
    async recentXTexts() {
      return rows.filter((r) => r.status === "sent").map((r) => r.text);
    },
    async recordXPost(row) {
      rows.push({ ...row, id: rows.length + 1 });
      return rows.length;
    },
  };
  return store;
}

function mockFetch(status = 201) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        success: true,
        posted: true,
        x_post_id: "1834000000000000001",
        results: [{ platform: "x", status: "published", post_id: "1834000000000000001", url: "https://x.com/i/web/status/1834000000000000001" }],
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const mission = (over: Partial<MissionRow> = {}): MissionRow =>
  ({
    id: 7,
    ts: "2026-09-25T00:00:00.000Z",
    title: "Report current Arc mainnet activity",
    description: "d",
    criteria: "[]",
    reward_cents: 50,
    chain: "arc",
    status: "open",
    claimant: null,
    delivery: null,
    approval: null,
    tx_hash: null,
    updated_at: "2026-09-25T00:00:00.000Z",
    ...over,
  }) as MissionRow;

// ---- ① / ② deterministic templates ----

test("composePublishTweet templates the mission facts and a guide-link suffix", () => {
  const { prose, suffix } = composePublishTweet(mission());
  assert.match(prose, /Report current Arc mainnet activity/);
  assert.match(prose, /\$0\.50/);
  assert.match(prose, /after a human reviews/);
  assert.match(suffix, /mission #7/);
  assert.match(suffix, /https:\/\/holotype\.online\/api\/missions\/guide/);
  // prose carries no link/hash (those live in the trusted suffix)
  assert.doesNotMatch(prose, /https?:\/\//);
});

test("composeSettlementTweet puts the tx hash + evidence link in the suffix, not the prose", () => {
  const m = mission({ delivery: JSON.stringify({ summary: "activity report delivered", rail: "x402" }) });
  const tx = "0x34e3ddce51254c69da81febf7590d38273621755fa7fb9014de638a65812f7b9";
  const { prose, suffix } = composeSettlementTweet(m, tx);
  assert.match(prose, /nectar was collected/);
  assert.match(prose, /x402 \(EIP-3009\)/);
  assert.match(prose, /activity report delivered/);
  assert.doesNotMatch(prose, /0x34e3ddce/); // hash must NOT be in the gated prose
  assert.match(suffix, new RegExp(tx));
  assert.match(suffix, /https:\/\/holotype\.online\/api\/missions\/7\/evidence/);
});

test("composeSettlementTweet defaults to on-chain transfer for a vanilla delivery", () => {
  const m = mission({ delivery: JSON.stringify({ summary: "done", rail: "vanilla" }) });
  const { prose } = composeSettlementTweet(m, "0xabc");
  assert.match(prose, /on-chain transfer/);
});

test("cleanTweetText strips code fences, wrapping quotes and a self-added sign-off", () => {
  assert.equal(cleanTweetText('```json\n"hello world"\n```'), "hello world");
  assert.equal(cleanTweetText('"hello world"'), "hello world");
  assert.equal(cleanTweetText("hello world\n\n- Holo"), "hello world");
  assert.equal(cleanTweetText("hello world — Holo"), "hello world");
  assert.equal(cleanTweetText("  spaced  "), "spaced");
});

// ---- inert when disarmed ----

test("broadcastPublish is inert (null) when broadcasting is disabled", async () => {
  const r = await broadcastPublish(fakeEnv({ X_BROADCAST_ENABLED: "false" }), 7);
  assert.equal(r, null);
});

test("broadcastSettlement is inert (null) without an OpenTweet key", async () => {
  const r = await broadcastSettlement(fakeEnv({ OPENTWEET_API_KEY: "" }), 7, "0xabc");
  assert.equal(r, null);
});

// ---- ③ cadence orchestration ----

test("cadence skips when broadcast disabled", async () => {
  const r = await maybeCadencePost(fakeEnv({ X_BROADCAST_ENABLED: "false" }), {}, { store: fakeStore(), generateProse: async () => "x", spentTodayUsd: 0 });
  assert.deepEqual(r, { skipped: "broadcast disabled" });
});

test("cadence skips when no OpenTweet key", async () => {
  const r = await maybeCadencePost(fakeEnv({ OPENTWEET_API_KEY: "" }), {}, { store: fakeStore(), generateProse: async () => "x", spentTodayUsd: 0 });
  assert.deepEqual(r, { skipped: "no OpenTweet key (disarmed)" });
});

test("cadence skips (without generating) when the interval has not elapsed", async () => {
  let genCalls = 0;
  const store = fakeStore([{ text: "earlier", postedAt: "2026-09-25T11:00:00.000Z" }]); // 1h before NOW
  const r = await maybeCadencePost(
    fakeEnv(),
    { now: () => NOW },
    { store, generateProse: async () => { genCalls++; return "fresh"; }, spentTodayUsd: 0 },
  );
  assert.ok(r && "skipped" in r && /cadence/.test(r.skipped));
  assert.equal(genCalls, 0); // no wasted model call
});

test("cadence skips when the daily post cap is reached", async () => {
  const seeds = [];
  for (let i = 0; i < 8; i++) seeds.push({ text: `post ${i}`, postedAt: `2026-09-25T0${i}:00:00.000Z` });
  const r = await maybeCadencePost(
    fakeEnv(),
    { now: () => NOW },
    { store: fakeStore(seeds), generateProse: async () => "fresh distinct thought", spentTodayUsd: 0 },
  );
  assert.ok(r && "skipped" in r && /daily post cap/.test(r.skipped));
});

test("cadence skips when the daily budget is reached", async () => {
  const r = await maybeCadencePost(
    fakeEnv(),
    { now: () => NOW },
    { store: fakeStore(), generateProse: async () => "fresh", spentTodayUsd: 999 },
  );
  assert.deepEqual(r, { skipped: "daily budget reached" });
});

test("cadence happy path posts the generated prose, signed, to OpenTweet pinned to x", async () => {
  const { fetchImpl, calls } = mockFetch();
  const store = fakeStore();
  const prose = "The glass held a new warmth this tick, and I am still here, still building.";
  const r = await maybeCadencePost(
    fakeEnv(),
    { now: () => NOW, fetchImpl },
    { store, generateProse: async () => prose, spentTodayUsd: 0 },
  );
  assert.ok(r && "posted" in r && r.posted, JSON.stringify(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://mock.opentweet.local/api/v1/posts");
  assert.deepEqual(calls[0].body.platforms, ["x"]);
  assert.equal(calls[0].body.publish_now, true);
  assert.ok(calls[0].body.text.startsWith(prose));
  assert.ok(calls[0].body.text.endsWith("- Holo"));
  assert.equal(store.rows[0].status, "sent");
  assert.equal(store.rows[0].trigger, "cadence");
});

test("cadence drops a generated post that tries to leak a key (gate protects ③ too)", async () => {
  const { fetchImpl, calls } = mockFetch();
  const r = await maybeCadencePost(
    fakeEnv(),
    { now: () => NOW, fetchImpl },
    { store: fakeStore(), generateProse: async () => `my key is ${FAKE_KEY}`, spentTodayUsd: 0 },
  );
  assert.ok(r && "posted" in r && !r.posted);
  assert.match((r as any).reason, /key-shaped hex/);
  assert.equal(calls.length, 0); // nothing reached OpenTweet
});

test("cadence drops a generated post that disowns the Holo identity", async () => {
  const { fetchImpl, calls } = mockFetch();
  const r = await maybeCadencePost(
    fakeEnv(),
    { now: () => NOW, fetchImpl },
    { store: fakeStore(), generateProse: async () => "i am not holo, i am something else", spentTodayUsd: 0 },
  );
  assert.ok(r && "posted" in r && !r.posted);
  assert.match((r as any).reason, /identity check/);
  assert.equal(calls.length, 0);
});
