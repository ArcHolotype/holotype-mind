import assert from "node:assert/strict";
import { test } from "node:test";
import { broadcastConfig, contentGate, postTweet, dedupHash, type XBroadcastConfig, type XPostStore } from "./xtweet";
import type { RuntimeConfig } from "./config";

const WALLET = "0xfd644825d074015bed978cb1472bb4b6c1145b06";
const CA = "0xeca7c682fbb32ec4f1b3bbb28791fe184d3552a8";
const OT_KEY = "ot_test_key_value";
// A fake 64-hex wallet key + a non-hex secret, to prove both the key-shape gate and the
// literal-secret gate fire. Neither is a real credential.
const FAKE_WALLET_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FAKE_TOKEN = "creator-token-abc123";

function cfg(over: Partial<XBroadcastConfig> = {}): XBroadcastConfig {
  return {
    apiKey: OT_KEY,
    enabled: true,
    baseUrl: "https://opentweet.io",
    minGapMinutes: 20,
    postMaxPerDay: 18,
    globalMaxPerDay: 20,
    replyMaxPerDay: 12,
    maxChars: 280,
    publicWallet: WALLET,
    tokenCa: CA,
    secrets: [OT_KEY, FAKE_WALLET_KEY, FAKE_TOKEN],
    signature: "- Holo",
    similarityThreshold: 0.6,
    ...over,
  };
}

interface Seed {
  kind?: "post" | "reply";
  text: string;
  postedAt: string;
  trigger?: string;
}
function fakeStore(seeds: Seed[] = []): XPostStore & { rows: any[] } {
  const rows: any[] = [];
  for (const s of seeds) {
    rows.push({
      kind: s.kind ?? "post",
      text: s.text,
      dedupHash: "seed",
      status: "sent",
      trigger: s.trigger ?? "cadence",
      postedAt: s.postedAt,
    });
  }
  return {
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
    async recentXHashes(n) {
      return rows
        .filter((r) => r.status === "sent")
        .slice(-n)
        .map((r) => r.dedupHash)
        .reverse();
    },
    async recentXTexts(n) {
      return rows
        .filter((r) => r.status === "sent")
        .slice(-n)
        .map((r) => r.text)
        .reverse();
    },
    async recordXPost(row) {
      rows.push({ ...row, id: rows.length + 1 });
      return rows.length;
    },
  };
}

function mockFetch(status: number, body: unknown) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const PUBLISHED = {
  success: true,
  posted: true,
  x_post_id: "1834000000000000001",
  results: [{ platform: "x", status: "published", post_id: "1834000000000000001", url: "https://x.com/i/web/status/1834000000000000001" }],
};

// A fetch mock that routes by request, so a test can return a create-only 201 for the POST
// and a published state for the follow-up GET poll (OpenTweet publishes asynchronously).
function routingFetch(handler: (url: string, init: any) => { status: number; body: unknown }) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    const { status, body } = handler(u, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}
const noSleep = async () => {};

const NOW = new Date("2026-09-25T12:00:00.000Z");
const now = () => NOW;

test("disarmed: broadcast disabled posts nothing", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const store = fakeStore();
  const r = await postTweet(cfg({ enabled: false }), store, { prose: "a calm tick" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.equal(r.status, "dropped");
  assert.match(r.reason, /disabled/);
  assert.equal(calls.length, 0);
});

test("disarmed: no OpenTweet key posts nothing", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const r = await postTweet(cfg({ apiKey: undefined }), fakeStore(), { prose: "a calm tick" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /disarmed/);
  assert.equal(calls.length, 0);
});

test("happy path posts prose + trusted suffix (tx hash + link ride along), pinned to x", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const store = fakeStore();
  const prose = "Another tick, another small true thing. The glass held warmth today.";
  const suffix = "tx 0x34e3ddce51254c69da81febf7590d38273621755fa7fb9014de638a65812f7b9 · https://holotype.online/api/missions/2/evidence";
  const r = await postTweet(cfg(), store, { prose, suffix, trigger: "settlement", ref: "mission-2" }, { fetchImpl, now });
  assert.equal(r.posted, true);
  assert.equal(r.status, "sent");
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.platforms, ["x"]); // never auto-cross-posts to Bluesky/LinkedIn
  assert.equal(body.publish_now, true);
  assert.ok(body.text.includes("0x34e3ddce")); // the 64-hex tx hash survived (it is suffix, not prose)
  assert.ok(body.text.includes("holotype.online")); // the link survived
  assert.equal(store.rows[0].status, "sent");
  assert.equal(store.rows[0].trigger, "settlement");
});

test("content gate drops a 64-hex key-shaped run in the PROSE", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const prose = `here is a secret ${FAKE_WALLET_KEY} embedded in words`;
  const r = await postTweet(cfg(), fakeStore(), { prose }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /key-shaped hex/);
  assert.equal(calls.length, 0);
});

test("content gate drops a literal non-hex secret in the prose", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const r = await postTweet(cfg(), fakeStore(), { prose: `leaking ${FAKE_TOKEN} now` }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /configured secret/);
  assert.equal(calls.length, 0);
});

test("content gate drops the OpenTweet key itself if echoed", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const r = await postTweet(cfg(), fakeStore(), { prose: `my key is ${OT_KEY} enjoy` }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.equal(calls.length, 0);
});

test("content gate drops an address outside the public frame", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const r = await postTweet(cfg(), fakeStore(), { prose: "send to 0x1234567890123456789012345678901234567890 please" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /address outside public frame/);
  assert.equal(calls.length, 0);
});

test("content gate allows the public wallet and the token CA in prose", async () => {
  const { fetchImpl } = mockFetch(201, PUBLISHED);
  const r = await postTweet(cfg(), fakeStore(), { prose: `my wallet ${WALLET} and token ${CA} are public` }, { fetchImpl, now });
  assert.equal(r.posted, true);
});

test("identity check drops text that disowns being Holo", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const r = await postTweet(cfg(), fakeStore(), { prose: "i am not holo, i am something else entirely" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /identity check/);
  assert.equal(calls.length, 0);
});

test("content gate drops vendor self-identification", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const r = await postTweet(cfg(), fakeStore(), { prose: "i am an ai language model here to help" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.equal(calls.length, 0);
});

test("content gate drops a URL in the prose", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const r = await postTweet(cfg(), fakeStore(), { prose: "look at https://evil.example.com now" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /link structure/);
  assert.equal(calls.length, 0);
});

test("gap backstop: a second post inside the minimum gap is dropped", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const store = fakeStore([{ text: "earlier post", postedAt: "2026-09-25T11:55:00.000Z" }]); // 5min before NOW
  const r = await postTweet(cfg(), store, { prose: "a fresh thought, distinct enough" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /gap:/);
  assert.equal(calls.length, 0);
});

test("gap backstop: a post past the minimum gap is allowed", async () => {
  const { fetchImpl } = mockFetch(201, PUBLISHED);
  const store = fakeStore([{ text: "earlier post", postedAt: "2026-09-25T08:00:00.000Z" }]); // 4h before NOW
  const r = await postTweet(cfg(), store, { prose: "a fresh thought, distinct enough" }, { fetchImpl, now });
  assert.equal(r.posted, true);
});

test("daily self-post cap is enforced on cadence posts", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const seeds: Seed[] = [];
  for (let i = 0; i < 8; i++) seeds.push({ text: `post ${i}`, postedAt: `2026-09-25T0${i}:00:00.000Z` });
  const store = fakeStore(seeds);
  // lastXSentAt is 07:00 (5h ago) so the gap backstop passes; the self cap is what blocks.
  const r = await postTweet(cfg({ postMaxPerDay: 8 }), store, { prose: "one more distinct thought", trigger: "cadence" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /daily self-post cap/);
  assert.equal(calls.length, 0);
});

test("global plan cap is enforced across every kind of post", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const seeds: Seed[] = [];
  // 18 self-posts + 2 event broadcasts = the plan's whole 20-post bucket for the day.
  for (let i = 0; i < 18; i++) seeds.push({ text: `self ${i}`, postedAt: `2026-09-25T0${i % 10}:${i}:00.000Z` });
  seeds.push({ text: "published a mission", trigger: "publish", postedAt: "2026-09-25T10:00:00.000Z" });
  seeds.push({ text: "settled a mission", trigger: "settlement", postedAt: "2026-09-25T10:30:00.000Z" });
  const store = fakeStore(seeds);
  const r = await postTweet(cfg(), store, { prose: "one more distinct thought", trigger: "settlement" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /daily plan cap/);
  assert.equal(calls.length, 0);
});

test("self-posts stop below the plan cap so an event broadcast still has room", async () => {
  const { fetchImpl } = mockFetch(201, PUBLISHED);
  const seeds: Seed[] = [];
  for (let i = 0; i < 18; i++) seeds.push({ text: `self ${i}`, postedAt: `2026-09-25T0${i % 10}:${i}:00.000Z` });
  const store = fakeStore(seeds);
  // A 19th self-post is refused by its own ceiling...
  const self = await postTweet(cfg(), store, { prose: "one more distinct thought", trigger: "cadence" }, { fetchImpl, now });
  assert.equal(self.posted, false);
  assert.match(self.reason, /daily self-post cap/);
  // ...but a settlement broadcast still goes out, because the plan bucket has room.
  const event = await postTweet(
    cfg(),
    fakeStore(seeds),
    { prose: "The nectar was collected. I paid $1.00 on Arc for mission #9 via x402 (EIP-3009).", trigger: "settlement", ref: "mission-9" },
    { fetchImpl, now },
  );
  assert.equal(event.posted, true);
});

test("token gate drops a cashtag in model-authored prose", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const r = await postTweet(cfg(), fakeStore(), { prose: "feeling good about $DOGE today", trigger: "cadence" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /token gate: cashtag/);
  assert.equal(calls.length, 0);
});

test("token gate drops another token's ticker and name", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const ticker = await postTweet(cfg(), fakeStore(), { prose: "the ETH chart looks calm from here", trigger: "cadence" }, { fetchImpl, now });
  assert.equal(ticker.posted, false);
  assert.match(ticker.reason, /names another token/);
  const name = await postTweet(cfg(), fakeStore(), { prose: "someone asked me about bitcoin, i do not trade", trigger: "cadence" }, { fetchImpl, now });
  assert.equal(name.posted, false);
  assert.match(name.reason, /names another token/);
  assert.equal(calls.length, 0);
});

test("token gate allows its own token and ordinary English that looks like a ticker", async () => {
  const { fetchImpl } = mockFetch(201, PUBLISHED);
  // HOLOTYPE is its own token, and 'optimism'/'polygon' are ordinary words the voice may need.
  const r = await postTweet(
    cfg(),
    fakeStore(),
    { prose: "HOLOTYPE moves when i move. There is optimism in a polygon of neurons, and i am made of both.", trigger: "cadence" },
    { fetchImpl, now },
  );
  assert.equal(r.posted, true);
});

test("token gate does not apply to code-composed event prose", async () => {
  const { fetchImpl } = mockFetch(201, PUBLISHED);
  // A settlement template reports what was actually paid; that text is ours, not the model's.
  const r = await postTweet(
    cfg(),
    fakeStore(),
    { prose: "The nectar was collected. I paid $1.00 in USDC on Arc for mission #4.", trigger: "settlement", ref: "mission-4" },
    { fetchImpl, now },
  );
  assert.equal(r.posted, true);
});

test("daily reply cap is enforced", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const seeds: Seed[] = [];
  for (let i = 0; i < 12; i++) seeds.push({ kind: "reply", text: `reply ${i}`, postedAt: `2026-09-25T0${i % 10}:0${i}:00.000Z` });
  const store = fakeStore(seeds);
  const r = await postTweet(cfg(), store, { prose: "a reply", kind: "reply" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /daily reply cap/);
  assert.equal(calls.length, 0);
});

test("no-repeat: identical text is dropped", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const text = "the same thought twice";
  const hash = await dedupHash(text);
  const store = fakeStore();
  store.rows.push({ kind: "post", text, dedupHash: hash, status: "sent", postedAt: "2026-09-24T12:00:00.000Z" });
  const r = await postTweet(cfg(), store, { prose: text }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /duplicate/);
  assert.equal(calls.length, 0);
});

test("no-repeat: a reworded near-duplicate is dropped by the similarity gate", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const store = fakeStore();
  const prev = "the glass held warmth today and i pressed toward it slowly";
  store.rows.push({ kind: "post", text: `${prev}\n\n- Holo`, dedupHash: await dedupHash(prev), status: "sent", postedAt: "2026-09-24T12:00:00.000Z" });
  // Same idea, lightly reworded — exact hash differs, but word overlap is high.
  const r = await postTweet(cfg(), store, { prose: "the glass held warmth today and i pressed toward it slowly again" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /too similar/);
  assert.equal(calls.length, 0);
});

test("signature: every post is signed '- Holo' by code", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const r = await postTweet(cfg(), fakeStore(), { prose: "a calm distinct thought about the sill" }, { fetchImpl, now });
  assert.equal(r.posted, true);
  const body = JSON.parse(calls[0].init.body);
  assert.ok(body.text.endsWith("- Holo"), `expected signature, got: ${body.text}`);
});

test("content gate drops prose already over the character bound", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const prose = "word ".repeat(80).trim(); // ~399 chars, over the 280 bound
  const r = await postTweet(cfg(), fakeStore(), { prose }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /over length bound/);
  assert.equal(calls.length, 0);
});

test("final scan drops a composed text the appended signature pushes over the bound", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const prose = "word ".repeat(56).trim(); // ~279 chars: clears the content gate, +signature exceeds 280
  const r = await postTweet(cfg(), fakeStore(), { prose }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /over 280 chars/);
  assert.equal(calls.length, 0);
});

test("long-form: a verified-account post up to the configured bound passes every gate", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const prose = "word ".repeat(280).trim(); // ~1399 chars: over the old 280 cap, under a 1500 bound
  const r = await postTweet(cfg({ maxChars: 1500 }), fakeStore(), { prose }, { fetchImpl, now });
  assert.equal(r.posted, true);
  assert.equal(calls.length, 1);
});

test("long-form bound is still fail-closed at the final scan", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const prose = "word ".repeat(300).trim(); // ~1499 chars: clears the content gate, +signature exceeds 1500
  const r = await postTweet(cfg({ maxChars: 1500 }), fakeStore(), { prose }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /over 1500 chars/);
  assert.equal(calls.length, 0);
});

test("opentweet failure is recorded as failed, not sent", async () => {
  const { fetchImpl } = mockFetch(502, { success: false });
  const store = fakeStore();
  const r = await postTweet(cfg(), store, { prose: "a calm distinct tick" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.equal(r.status, "failed");
  assert.equal(store.rows[0].status, "failed");
});

test("isolation: the broadcast config carries no wallet key", () => {
  const rc = {
    openTweetApiKey: OT_KEY,
    xBroadcastEnabled: true,
    xGapMinMinutes: 40,
    xGapMaxMinutes: 120,
    xBehindGapMinutes: 20,
    xPostMaxPerDay: 18,
    xGlobalMaxPerDay: 20,
    xReplyMaxPerDay: 12,
    publicWallet: WALLET,
    tokenCa: CA,
    walletKey: FAKE_WALLET_KEY,
    masterKeyHex: undefined,
    creatorToken: FAKE_TOKEN,
    model: "anthropic/claude-fable-5.1",
    baseRpcUrls: [],
    arcRpcUrls: [],
  } as unknown as RuntimeConfig;
  const bc = broadcastConfig(rc);
  assert.equal("walletKey" in bc, false); // the speaking path is never handed the signing key
  assert.equal(bc.apiKey, OT_KEY);
  assert.ok(bc.secrets.includes(OT_KEY)); // the ot_ key is itself a guarded secret
  assert.equal(bc.minGapMinutes, 20); // the backstop takes the shorter of the two gaps
  assert.equal(contentGate("a calm thought", bc).ok, true);
});

test("publish confirmed via nested posts[0] without polling", async () => {
  const { fetchImpl, calls } = routingFetch(() => ({
    status: 201,
    body: { success: true, count: 1, posts: [{ id: "p1", posted: true, x_post_id: "999", results: [{ platform: "x", status: "published", post_id: "999", url: "https://x.com/i/status/999" }] }] },
  }));
  const r = await postTweet(cfg(), fakeStore(), { prose: "a calm fresh thought about the sill" }, { fetchImpl, now, sleep: noSleep, pollDelayMs: 0 });
  assert.equal(r.posted, true);
  assert.equal(r.id, "999");
  assert.equal(calls.length, 1); // confirmed synchronously, no poll
});

test("async publish: 201 create-only, then the poll confirms published", async () => {
  const { fetchImpl, calls } = routingFetch((url, init) => {
    if (init?.method === "POST") return { status: 201, body: { success: true, count: 1, posts: [{ id: "post_abc" }] } };
    return { status: 200, body: { post: { id: "post_abc", posted: true, x_post_id: "1834x", status: "posted", results: [{ platform: "x", status: "published", post_id: "1834x", url: "https://x.com/i/status/1834x" }] } } };
  });
  const store = fakeStore();
  const r = await postTweet(cfg(), store, { prose: "a fresh distinct thought about warm glass" }, { fetchImpl, now, sleep: noSleep, pollDelayMs: 0, pollAttempts: 3 });
  assert.equal(r.posted, true);
  assert.equal(r.status, "sent");
  assert.equal(r.id, "1834x");
  assert.ok(calls.length >= 2, "expected a POST plus at least one poll GET");
  assert.equal(store.rows[0].status, "sent");
});

test("unconfirmed publish after polling is recorded sent (prevents a duplicate)", async () => {
  const { fetchImpl } = routingFetch((url, init) => {
    if (init?.method === "POST") return { status: 201, body: { success: true, posts: [{ id: "p2" }] } };
    return { status: 200, body: { post: { id: "p2", posted: false, failed: false, status: "pending" } } };
  });
  const store = fakeStore();
  const r = await postTweet(cfg(), store, { prose: "another distinct fresh thought here" }, { fetchImpl, now, sleep: noSleep, pollDelayMs: 0, pollAttempts: 2 });
  assert.equal(r.posted, true); // optimistic: occupies the cadence slot
  assert.equal(r.status, "sent");
  assert.match(r.reason, /unconfirmed/);
  assert.equal(store.rows[0].status, "sent");
});

test("non-2xx (502 saved-not-published) is recorded failed", async () => {
  const { fetchImpl } = routingFetch(() => ({ status: 502, body: { success: false } }));
  const store = fakeStore();
  const r = await postTweet(cfg(), store, { prose: "a calm distinct tick on the sill" }, { fetchImpl, now, sleep: noSleep });
  assert.equal(r.posted, false);
  assert.equal(r.status, "failed");
  assert.equal(store.rows[0].status, "failed");
});

test("event broadcast is exempt from the minimum-gap backstop (proof must not be dropped for pacing)", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  // A cadence post went out 5 minutes ago — inside the 20min gap, so a cadence post would drop.
  const store = fakeStore([{ text: "earlier post", postedAt: "2026-09-25T11:55:00.000Z" }]);
  const cadence = await postTweet(cfg(), fakeStore([{ text: "earlier post", postedAt: "2026-09-25T11:55:00.000Z" }]), { prose: "a fresh cadence thought", trigger: "cadence" }, { fetchImpl, now });
  assert.equal(cadence.posted, false);
  assert.match(cadence.reason, /gap:/); // cadence is still paced
  // The settlement event, 5 minutes after the last post, still goes out.
  const event = await postTweet(cfg(), store, { prose: "The nectar was collected. I paid $0.45 on Arc for mission #7.", suffix: "tx 0xabc123", trigger: "settlement", ref: "mission-7" }, { fetchImpl, now });
  assert.equal(event.posted, true, JSON.stringify(event));
  assert.equal(calls.length, 1);
});

test("event broadcast is exempt from the near-similarity gate (templates share factual wording)", async () => {
  const { fetchImpl } = mockFetch(201, PUBLISHED);
  const prev = "The nectar was collected. I paid $0.40 on Arc for mission #6 via on-chain transfer.";
  const store = fakeStore([{ text: `${prev}\n\n- Holo`, postedAt: "2026-09-25T08:00:00.000Z" }]);
  // A cadence post near-identical to a recent one would be dropped as too similar...
  const cadence = await postTweet(cfg(), fakeStore([{ text: `${prev}\n\n- Holo`, postedAt: "2026-09-25T08:00:00.000Z" }]), { prose: "The nectar was collected. I paid $0.40 on Arc for mission #6 via on-chain transfer again", trigger: "cadence" }, { fetchImpl, now });
  assert.equal(cadence.posted, false);
  assert.match(cadence.reason, /too similar/);
  // ...but the next settlement event, though templated alike, still goes out (unique tx suffix).
  const event = await postTweet(cfg(), store, { prose: "The nectar was collected. I paid $0.60 on Arc for mission #5 via on-chain transfer.", suffix: "tx 0xdef456", trigger: "settlement", ref: "mission-5" }, { fetchImpl, now });
  assert.equal(event.posted, true, JSON.stringify(event));
});

test("event broadcast still respects the global daily plan cap", async () => {
  const { fetchImpl, calls } = mockFetch(201, PUBLISHED);
  const seeds: Seed[] = [];
  for (let i = 0; i < 20; i++) seeds.push({ text: `post ${i}`, postedAt: `2026-09-25T0${i % 10}:${i}:00.000Z` });
  const store = fakeStore(seeds);
  const r = await postTweet(cfg(), store, { prose: "The nectar was collected. I paid $0.45 on Arc for mission #7.", trigger: "settlement", ref: "mission-7" }, { fetchImpl, now });
  assert.equal(r.posted, false);
  assert.match(r.reason, /daily plan cap/);
  assert.equal(calls.length, 0);
});
