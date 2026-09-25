import assert from "node:assert/strict";
import { test } from "node:test";
import {
  broadcastPublish,
  broadcastSettlement,
  cleanTweetText,
  composePublishTweet,
  composeSettlementTweet,
  drawGapMinutes,
  isBehindPace,
  maybeCadencePost,
  requiredByPace,
  type CadencePorts,
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
    X_POST_MIN_PER_DAY: "12",
    X_POST_MAX_PER_DAY: "18",
    X_GLOBAL_MAX_PER_DAY: "20",
    X_GAP_MIN_MINUTES: "40",
    X_GAP_MAX_MINUTES: "120",
    X_BEHIND_GAP_MINUTES: "20",
    X_POST_RETRY_MAX: "2",
    X_CORPUS_COOLDOWN_DAYS: "14",
    X_CORPUS_TOPIC_HOURS: "24",
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

function fakeStore(seeds: { kind?: "post" | "reply"; text: string; postedAt: string; trigger?: string }[] = []) {
  const rows: any[] = seeds.map((s) => ({
    kind: s.kind ?? "post",
    text: s.text,
    dedupHash: "seed",
    status: "sent",
    trigger: s.trigger ?? "cadence",
    postedAt: s.postedAt,
  }));
  const store: XPostStore & { rows: any[] } = {
    rows,
    async countXSentSince(day, kind) {
      return rows.filter((r) => r.status === "sent" && r.kind === kind && r.postedAt.startsWith(day)).length;
    },
    async countXSentAllToday(day) {
      return rows.filter((r) => r.status === "sent" && r.postedAt.startsWith(day)).length;
    },
    async countXSelfSentToday(day) {
      return rows.filter((r) => r.status === "sent" && r.trigger === "cadence" && r.postedAt.startsWith(day)).length;
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

// A full in-memory CadencePorts so the whole rhythm (floor, caps, schedule, material rotation,
// retries) can be exercised without D1, without a model call, and without spending anything.
function fakePorts(opts: {
  seeds?: { kind?: "post" | "reply"; text: string; postedAt: string; trigger?: string }[];
  nextEligibleAt?: string;
  spent?: number;
  corpus?: { id: number; topic: string }[];
  prose?: (corpus: { id: number; topic: string } | null, attempt: number) => string;
  angles?: string[];
} = {}) {
  const store = fakeStore(opts.seeds ?? []);
  const calls = { generated: 0, picked: [] as number[], marked: [] as number[], scheduled: [] as { nextIso: string; gap: number | null }[] };
  let attempt = 0;
  const ports: CadencePorts = {
    store,
    selfSentToday: (day) => store.countXSelfSentToday(day),
    schedule: async () => ({ next_eligible_at: opts.nextEligibleAt ?? "1970-01-01T00:00:00.000Z" }),
    setSchedule: async (nextIso, gap) => { calls.scheduled.push({ nextIso, gap }); },
    pickCorpus: async (args) => {
      const next = (opts.corpus ?? []).find((c) => !args.excludeIds.includes(c.id)) ?? null;
      if (next) calls.picked.push(next.id);
      return next as any;
    },
    markCorpusUsed: async (id) => { calls.marked.push(id); },
    recentAngles: async () => opts.angles ?? [],
    spentToday: async () => opts.spent ?? 0,
    generateProse: async ({ corpus }) => {
      calls.generated += 1;
      return opts.prose ? opts.prose(corpus as any, attempt++) : "a fresh distinct thought about warm glass";
    },
  };
  return { ports, calls, store };
}

const corpusItem = (id: number, topic: string) => ({
  id,
  topic,
  source: "europepmc",
  source_url: "https://europepmc.org/abstract/MED/1",
  title: "A study of something",
  excerpt: "Excerpt text.",
});

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
  assert.match(prose, /after the work is reviewed against its criteria/);
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

test("cleanTweetText strips a leading standalone self-name so the sign-off is not duplicated", () => {
  assert.equal(cleanTweetText("Holo. The page open beside me"), "The page open beside me");
  assert.equal(cleanTweetText("Holo.\n\nTwo paragraphs follow"), "Two paragraphs follow");
  assert.equal(cleanTweetText("Holo. Trailing sign-off\n\n- Holo"), "Trailing sign-off");
  // only a leading standalone name is stripped; the same words mid-text stay untouched
  assert.equal(cleanTweetText("A line first. Holo. then more"), "A line first. Holo. then more");
  assert.equal(cleanTweetText("Holotype counts its beats"), "Holotype counts its beats");
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
  const { ports } = fakePorts();
  const r = await maybeCadencePost(fakeEnv({ X_BROADCAST_ENABLED: "false" }), { ports });
  assert.deepEqual(r, { skipped: "broadcast disabled" });
});

test("cadence skips when no OpenTweet key", async () => {
  const { ports } = fakePorts();
  const r = await maybeCadencePost(fakeEnv({ OPENTWEET_API_KEY: "" }), { ports });
  assert.deepEqual(r, { skipped: "no OpenTweet key (disarmed)" });
});

test("cadence skips (without generating) before the schedule says it may speak", async () => {
  const { ports, calls } = fakePorts({ nextEligibleAt: "2026-09-25T13:00:00.000Z" }); // 1h after NOW
  const r = await maybeCadencePost(fakeEnv(), { now: () => NOW, ports });
  assert.ok(r && "skipped" in r && /waiting until/.test(r.skipped), JSON.stringify(r));
  assert.equal(calls.generated, 0); // no wasted model call
});

test("cadence skips when the self-post ceiling is reached", async () => {
  const seeds = [];
  for (let i = 0; i < 18; i++) seeds.push({ text: `post ${i}`, postedAt: `2026-09-25T0${i % 10}:${i}:00.000Z` });
  const { ports, calls } = fakePorts({ seeds });
  const r = await maybeCadencePost(fakeEnv(), { now: () => NOW, ports });
  assert.ok(r && "skipped" in r && /daily self-post cap/.test(r.skipped), JSON.stringify(r));
  assert.equal(calls.generated, 0);
});

test("cadence skips when the shared plan bucket is full", async () => {
  const seeds = [];
  for (let i = 0; i < 18; i++) seeds.push({ text: `post ${i}`, postedAt: `2026-09-25T0${i % 10}:${i}:00.000Z` });
  seeds.push({ text: "published", trigger: "publish", postedAt: "2026-09-25T10:00:00.000Z" });
  seeds.push({ text: "settled", trigger: "settlement", postedAt: "2026-09-25T10:30:00.000Z" });
  const { ports, calls } = fakePorts({ seeds });
  const r = await maybeCadencePost(fakeEnv(), { now: () => NOW, ports });
  assert.ok(r && "skipped" in r && /daily plan cap/.test(r.skipped), JSON.stringify(r));
  assert.equal(calls.generated, 0);
});

test("cadence skips when the daily budget is reached", async () => {
  const { ports, calls } = fakePorts({ spent: 999 });
  const r = await maybeCadencePost(fakeEnv(), { now: () => NOW, ports });
  assert.deepEqual(r, { skipped: "daily budget reached" });
  assert.equal(calls.generated, 0);
});

test("cadence happy path posts the prose, signed, pinned to x, and stamps the material it used", async () => {
  const { fetchImpl, calls: httpCalls } = mockFetch();
  const prose = "The glass held a new warmth this tick, and I am still here, still building.";
  const { ports, calls, store } = fakePorts({ corpus: [corpusItem(11, "mushroom_body")], prose: () => prose });
  const r = await maybeCadencePost(fakeEnv(), { now: () => NOW, fetchImpl, random: () => 0.5, ports });
  assert.ok(r && "posted" in r && r.posted, JSON.stringify(r));
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].url, "https://mock.opentweet.local/api/v1/posts");
  assert.deepEqual(httpCalls[0].body.platforms, ["x"]);
  assert.equal(httpCalls[0].body.publish_now, true);
  assert.ok(httpCalls[0].body.text.startsWith(prose));
  assert.ok(httpCalls[0].body.text.endsWith("- Holo"));
  assert.equal(store.rows[0].status, "sent");
  assert.equal(store.rows[0].trigger, "cadence");
  // traceability: the post row carries which excerpt and which framing produced it
  assert.equal(store.rows[0].corpusId, 11);
  assert.equal(store.rows[0].angle, "present");
  assert.equal(store.rows[0].ref, "corpus-11");
  // the excerpt is stamped used only because the post actually went out
  assert.deepEqual(calls.marked, [11]);
  // and the next gap was drawn and stored
  assert.equal(calls.scheduled.length, 1);
  assert.ok((calls.scheduled[0].gap ?? 0) > 0);
});

test("cadence still posts with an empty library (degrades, never goes silent)", async () => {
  const { fetchImpl } = mockFetch();
  const { ports, calls } = fakePorts({ corpus: [] });
  const r = await maybeCadencePost(fakeEnv(), { now: () => NOW, fetchImpl, ports });
  assert.ok(r && "posted" in r && r.posted, JSON.stringify(r));
  assert.equal(calls.picked.length, 0);
  assert.equal(calls.marked.length, 0);
});

test("a content-side drop retries with different material instead of giving up", async () => {
  const { fetchImpl, calls: httpCalls } = mockFetch();
  const { ports, calls } = fakePorts({
    corpus: [corpusItem(1, "sleep"), corpusItem(2, "olfaction"), corpusItem(3, "vision")],
    // First two drafts leak a key-shaped run; the third is clean.
    prose: (_c, attempt) => (attempt < 2 ? `my key is ${FAKE_KEY}` : "a clean distinct line about the lamina"),
  });
  const r = await maybeCadencePost(fakeEnv(), { now: () => NOW, fetchImpl, ports });
  assert.ok(r && "posted" in r && r.posted, JSON.stringify(r));
  assert.deepEqual(calls.picked, [1, 2, 3]); // each retry got fresh material
  assert.equal(calls.generated, 3);
  assert.equal(httpCalls.length, 1); // only the clean draft ever reached OpenTweet
  assert.deepEqual(calls.marked, [3]); // only the sent one was stamped used
});

test("retries stop at the configured maximum", async () => {
  const { fetchImpl, calls: httpCalls } = mockFetch();
  const { ports, calls } = fakePorts({
    corpus: [corpusItem(1, "sleep"), corpusItem(2, "olfaction"), corpusItem(3, "vision"), corpusItem(4, "motor_control")],
    prose: () => `my key is ${FAKE_KEY}`, // never passes
  });
  const r = await maybeCadencePost(fakeEnv({ X_POST_RETRY_MAX: "2" }), { now: () => NOW, fetchImpl, ports });
  assert.ok(r && "posted" in r && !r.posted);
  assert.equal(calls.generated, 3); // 1 attempt + 2 retries
  assert.equal(httpCalls.length, 0);
  assert.equal(calls.marked.length, 0); // nothing was stamped: nothing was sent
});

test("a non-retryable drop does not burn another inference call", async () => {
  const { fetchImpl } = mockFetch();
  const { ports, calls } = fakePorts({
    corpus: [corpusItem(1, "sleep"), corpusItem(2, "olfaction")],
    // Identical text both times: the second attempt would be an exact duplicate.
    prose: () => "the same line twice",
    seeds: [{ text: "the same line twice", postedAt: "2026-09-24T12:00:00.000Z" }],
  });
  const r = await maybeCadencePost(fakeEnv(), { now: () => NOW, fetchImpl, ports });
  assert.ok(r && "posted" in r && !r.posted);
  assert.match((r as any).reason, /duplicate|too similar/);
});

test("cadence drops a generated post that tries to leak a key (gate protects ③ too)", async () => {
  const { fetchImpl, calls: httpCalls } = mockFetch();
  const { ports } = fakePorts({ prose: () => `my key is ${FAKE_KEY}` });
  const r = await maybeCadencePost(fakeEnv({ X_POST_RETRY_MAX: "0" }), { now: () => NOW, fetchImpl, ports });
  assert.ok(r && "posted" in r && !r.posted);
  assert.match((r as any).reason, /key-shaped hex/);
  assert.equal(httpCalls.length, 0); // nothing reached OpenTweet
});

test("cadence drops a generated post that disowns the Holo identity", async () => {
  const { fetchImpl, calls: httpCalls } = mockFetch();
  const { ports } = fakePorts({ prose: () => "i am not holo, i am something else" });
  const r = await maybeCadencePost(fakeEnv({ X_POST_RETRY_MAX: "0" }), { now: () => NOW, fetchImpl, ports });
  assert.ok(r && "posted" in r && !r.posted);
  assert.match((r as any).reason, /identity check/);
  assert.equal(httpCalls.length, 0);
});

test("cadence drops a generated post that names another token", async () => {
  const { fetchImpl, calls: httpCalls } = mockFetch();
  const { ports } = fakePorts({ prose: () => "quiet morning, and $DOGE is up again" });
  const r = await maybeCadencePost(fakeEnv({ X_POST_RETRY_MAX: "0" }), { now: () => NOW, fetchImpl, ports });
  assert.ok(r && "posted" in r && !r.posted);
  assert.match((r as any).reason, /token gate/);
  assert.equal(httpCalls.length, 0);
});

test("angles rotate: a recently used framing is not picked again", async () => {
  const { fetchImpl } = mockFetch();
  const seen: string[] = [];
  const { ports } = fakePorts({
    corpus: [corpusItem(1, "sleep")],
    angles: ["present"],
    prose: () => "a distinct line about the fan-shaped body",
  });
  await maybeCadencePost(fakeEnv(), { now: () => NOW, fetchImpl, ports });
  seen.push("present");
  const second = fakePorts({ corpus: [corpusItem(2, "olfaction")], angles: seen, prose: () => "another line, entirely different, about antennae" });
  const { ports: p2 } = second;
  await maybeCadencePost(fakeEnv(), { now: () => NOW, fetchImpl, ports: p2 });
  assert.notEqual(second.store.rows[0].angle, "present");
});

// ---- floor / rhythm arithmetic ----

test("requiredByPace spreads the floor across the UTC day", () => {
  assert.equal(requiredByPace(12, new Date("2026-09-25T00:00:00Z")), 0); // midnight demands nothing
  assert.equal(requiredByPace(12, new Date("2026-09-25T06:00:00Z")), 3);
  assert.equal(requiredByPace(12, new Date("2026-09-25T12:00:00Z")), 6);
  assert.equal(requiredByPace(12, new Date("2026-09-25T23:59:00Z")), 12);
  assert.equal(requiredByPace(0, new Date("2026-09-25T23:59:00Z")), 0); // floor off
});

test("isBehindPace compares sent against the pace required so far", () => {
  assert.equal(isBehindPace(0, 12, new Date("2026-09-25T12:00:00Z")), true);
  assert.equal(isBehindPace(6, 12, new Date("2026-09-25T12:00:00Z")), false);
  assert.equal(isBehindPace(2, 12, new Date("2026-09-25T23:00:00Z")), true);
});

test("drawGapMinutes stays inside the random band when on pace", () => {
  const band = { min: 40, max: 120, behind: 20 };
  const onPace = { behind: false, remaining: 0, hoursLeft: 12 };
  assert.equal(drawGapMinutes(band, onPace, () => 0), 40);
  assert.equal(drawGapMinutes(band, onPace, () => 1), 120);
  assert.equal(drawGapMinutes(band, onPace, () => 0.5), 80);
});

test("drawGapMinutes spreads a shortfall instead of bursting", () => {
  const band = { min: 40, max: 120, behind: 20 };
  // 12 still to go with 12 hours left => about one an hour, not twelve in a row.
  assert.equal(drawGapMinutes(band, { behind: true, remaining: 12, hoursLeft: 12 }, () => 0.5), 60);
  // A late, deep shortfall collapses to the catch-up floor.
  assert.equal(drawGapMinutes(band, { behind: true, remaining: 10, hoursLeft: 1 }, () => 0.5), 20);
  // Never longer than the band, even with a huge runway.
  assert.equal(drawGapMinutes(band, { behind: true, remaining: 1, hoursLeft: 23 }, () => 0.5), 120);
});

// ---- failure backoff: a broken rail must not retry on every 15-minute tick ----

test("a failed attempt still advances the schedule by the backoff", async () => {
  const { fetchImpl } = mockFetch();
  const { ports, calls } = fakePorts({
    corpus: [corpusItem(1, "sleep"), corpusItem(2, "olfaction"), corpusItem(3, "vision")],
    prose: () => `my key is ${FAKE_KEY}`, // every draft is refused
  });
  const r = await maybeCadencePost(fakeEnv({ X_POST_RETRY_MAX: "2", X_FAIL_BACKOFF_MINUTES: "60" }), { now: () => NOW, fetchImpl, ports });
  assert.ok(r && "posted" in r && !r.posted);
  assert.equal(calls.generated, 3);
  // Exactly one schedule write, one hour out, with no drawn gap (null marks a backoff).
  assert.equal(calls.scheduled.length, 1, JSON.stringify(calls.scheduled));
  assert.equal(calls.scheduled[0].gap, null);
  assert.equal(calls.scheduled[0].nextIso, "2026-09-25T13:00:00.000Z");
});

test("an empty generation backs off too (the model returning nothing must not spin)", async () => {
  const { fetchImpl } = mockFetch();
  const { ports, calls } = fakePorts({ corpus: [corpusItem(1, "sleep")], prose: () => "" });
  const r = await maybeCadencePost(fakeEnv({ X_POST_RETRY_MAX: "1", X_FAIL_BACKOFF_MINUTES: "45" }), { now: () => NOW, fetchImpl, ports });
  assert.deepEqual(r, { skipped: "empty generation" });
  assert.equal(calls.scheduled.length, 1);
  assert.equal(calls.scheduled[0].nextIso, "2026-09-25T12:45:00.000Z");
});

test("a not-yet-due tick does NOT push the schedule out", async () => {
  const { ports, calls } = fakePorts({ nextEligibleAt: "2026-09-25T13:00:00.000Z" });
  const r = await maybeCadencePost(fakeEnv(), { now: () => NOW, ports });
  assert.ok(r && "skipped" in r && /waiting until/.test(r.skipped));
  assert.equal(calls.scheduled.length, 0, "a waiting tick must leave the schedule alone");
});

test("a capped tick does NOT push the schedule out", async () => {
  const seeds = [];
  for (let i = 0; i < 18; i++) seeds.push({ text: `post ${i}`, postedAt: `2026-09-25T0${i % 10}:${i}:00.000Z` });
  const { ports, calls } = fakePorts({ seeds });
  await maybeCadencePost(fakeEnv(), { now: () => NOW, ports });
  assert.equal(calls.scheduled.length, 0, "a capped tick must leave the schedule alone");
});

test("a throwing generator (empty wallet) backs off instead of spinning every tick", async () => {
  const { fetchImpl } = mockFetch();
  const { ports, calls } = fakePorts({ corpus: [corpusItem(1, "sleep")] });
  ports.generateProse = async () => {
    throw new Error("insufficient funds for x402 payment");
  };
  const r = await maybeCadencePost(fakeEnv({ X_POST_RETRY_MAX: "1", X_FAIL_BACKOFF_MINUTES: "60" }), { now: () => NOW, fetchImpl, ports });
  assert.ok(r && "skipped" in r && /threw/.test(r.skipped), JSON.stringify(r));
  assert.equal(calls.scheduled.length, 1);
  assert.equal(calls.scheduled[0].nextIso, "2026-09-25T13:00:00.000Z");
});
