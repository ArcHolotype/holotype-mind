// X (Twitter) broadcast orchestration — the worker-controlled rail that decides WHEN Holo
// speaks and WHAT factual suffix to attach. Three triggers:
//   ① publish    — a Nectar mission was published (deterministic template, no model call)
//   ② settlement — a mission was paid on-chain (deterministic template + tx/evidence suffix)
//   ③ cadence    — Holo posts a fresh thought of its own (one model call per attempt)
//
// ISOLATION: this rail never sends the wallet key to OpenTweet. The key is used only to pay
// BlockRun for the ③ inference (exactly as every heartbeat does); the posting itself goes
// through xtweet.ts with the OpenTweet ot_ key only. Every outbound text passes the
// fail-closed gate in xtweet.ts (disclosure + identity + token discipline + dedup + similarity
// + caps + final scan). The whole rail is inert unless X_BROADCAST_ENABLED is true AND an
// OpenTweet key is set.
//
// RHYTHM. The user's spec is a band, not a metronome: no fewer than X_POST_MIN_PER_DAY and no
// more than X_POST_MAX_PER_DAY self-posts per UTC day, at times that are not fixed. So the gap
// to the next post is drawn at random after each one, and a floor recovers the day if it falls
// behind pace — the floor is computed from how much of the UTC day has elapsed, so a slow
// morning shortens the afternoon gaps instead of dumping twelve posts at midnight.
//
// MATERIAL. A ③ post is written from one vetted corpus excerpt (src/corpus.ts) plus one
// code-chosen angle. Both rotate under SQL-enforced cooldowns, so the anti-repeat guarantee
// does not depend on the model feeling inventive. An empty library degrades to the old
// behaviour (write from recent inner monologue) rather than going silent.

import { LLMClient } from "@blockrun/llm";
import { readConfig, type Env, type RuntimeConfig } from "./config.js";
import { buildBroadcastPrompt, parseJson } from "./prompt.js";
import { secretValues } from "./disclose.js";
import {
  buildPickQuery,
  ingestCorpus,
  pickAngle,
  type CorpusRow,
  type FetchImpl,
  type IngestResult,
} from "./corpus.js";
import { broadcastConfig, postTweet, type PostResult, type XPostStore, type XTweetDeps } from "./xtweet.js";
import {
  countXSelfSentToday,
  countXSentAllToday,
  countXSentSince,
  corpusStore,
  getMission,
  getXSchedule,
  lastXSentAt,
  markCorpusUsed,
  recentDarkroom,
  recentXAngles,
  recentXHashes,
  recentXPosts,
  recentXTexts,
  recordXPost,
  setXSchedule,
  spendTodayUsd,
  type MissionRow,
} from "./store.js";

export type BroadcastOutcome = PostResult | { skipped: string } | null;

// Bind the D1 store to the XPostStore port the gate expects.
function xStore(db: D1Database): XPostStore {
  return {
    countXSentSince: (day, kind) => countXSentSince(db, day, kind),
    countXSentAllToday: (day) => countXSentAllToday(db, day),
    countXSelfSentToday: (day) => countXSelfSentToday(db, day),
    lastXSentAt: (kind) => lastXSentAt(db, kind),
    recentXHashes: (n) => recentXHashes(db, n),
    recentXTexts: (n) => recentXTexts(db, n),
    recordXPost: (row) => recordXPost(db, row),
  };
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

function parseDelivery(row: MissionRow): { summary?: string; artifact?: string; rail?: string } {
  try {
    return JSON.parse(row.delivery ?? "{}");
  } catch {
    return {};
  }
}

// Strip model artifacts (code fences, wrapping quotes, a self-added sign-off) so the rail's
// own signature is not duplicated and the gate sees clean prose.
export function cleanTweetText(raw: string): string {
  let t = String(raw ?? "").replace(/```(?:json)?|```/g, "").trim();
  t = t.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  t = t.replace(/\s*[-–—~]\s*Holo\s*$/i, "").trim();
  return t;
}

// ① publish broadcast — deterministic template from the mission row. No model call, so no
// inference cost and no wallet-key use. The mission title already passed the disclosure gate
// at creation; it is re-gated here as prose before posting.
export function composePublishTweet(m: MissionRow): { prose: string; suffix: string } {
  const title = m.title.trim().slice(0, 100);
  const prose = `I just published a mission. I need: ${title}. Reward ${usd(m.reward_cents)} on Arc, paid only after a human reviews the work.`;
  const suffix = `mission #${m.id} · guide: https://holotype.online/api/missions/guide`;
  return { prose, suffix };
}

// ② settlement broadcast — deterministic template + the on-chain proof as a trusted suffix.
// The tx hash and evidence link live in the suffix (code-controlled), never in the gated prose,
// so the 64-hex hash and the URL never trip the prose gate yet still ride along publicly.
export function composeSettlementTweet(m: MissionRow, txHash: string): { prose: string; suffix: string } {
  const delivery = parseDelivery(m);
  const rail = delivery.rail === "x402" ? "x402 (EIP-3009)" : "on-chain transfer";
  const got = (delivery.summary ?? "the completed work").trim().slice(0, 60);
  const prose = `The nectar was collected. I paid ${usd(m.reward_cents)} on Arc for mission #${m.id} via ${rail} and got: ${got}.`;
  const suffix = `tx ${txHash} · https://holotype.online/api/missions/${m.id}/evidence`;
  return { prose, suffix };
}

// ---------------------------------------------------------------------------
// ③ cadence: floor, random rhythm, material rotation.
// ---------------------------------------------------------------------------

// How many self-posts the day should have reached by this moment, if the floor is to be met
// without a midnight burst. Ceiling rather than floor so the rail is always slightly ahead.
export function requiredByPace(minPerDay: number, now: Date): number {
  if (minPerDay <= 0) return 0;
  const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  return Math.ceil((minPerDay * hours) / 24);
}

export function isBehindPace(selfSent: number, minPerDay: number, now: Date): boolean {
  return selfSent < requiredByPace(minPerDay, now);
}

// The next gap. On pace, random inside the configured band so the rhythm is not a metronome.
// Behind pace, the shortfall is spread across the hours left instead of being dumped now: a
// fixed short gap would produce a visible burst, while spreading converges on the floor by
// midnight and still reads like an organism posting when it has something to say.
export function drawGapMinutes(
  band: { min: number; max: number; behind: number },
  state: { behind: boolean; remaining: number; hoursLeft: number },
  random: () => number = Math.random,
): number {
  const lo = Math.max(1, band.min);
  const hi = Math.max(lo, band.max);
  if (!state.behind) return Math.round(lo + random() * (hi - lo));
  const remaining = Math.max(1, state.remaining);
  const spread = Math.ceil((Math.max(0, state.hoursLeft) * 60) / remaining);
  return Math.max(band.behind, Math.min(spread, hi));
}

// Hours left in the current UTC day, for the spread above.
export function hoursLeftInUtcDay(now: Date): number {
  return 24 - (now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600);
}

export type CorpusPick = Pick<CorpusRow, "id" | "topic" | "source" | "source_url" | "title" | "excerpt">;

// Everything the cadence path touches, injected so the whole rhythm can be exercised in tests
// without D1, without a model call, and without spending anything.
export interface CadencePorts {
  store: XPostStore;
  selfSentToday(day: string): Promise<number>;
  schedule(): Promise<{ next_eligible_at: string }>;
  setSchedule(nextIso: string, gapMinutes: number | null, at: string): Promise<void>;
  pickCorpus(args: { cooldownCutoffIso: string; topicCutoffIso: string; excludeIds: number[] }): Promise<CorpusPick | null>;
  markCorpusUsed(corpusId: number, at: string): Promise<void>;
  recentAngles(n: number): Promise<string[]>;
  spentToday(day: string): Promise<number>;
  generateProse(input: { corpus: CorpusPick | null; angle: { key: string; instruction: string } }): Promise<string>;
}

export interface CadenceDeps extends XTweetDeps {
  random?: () => number;
  ports?: Partial<CadencePorts>;
}

// A drop for these reasons means "not now" rather than "this text was bad", so retrying with
// fresh material would just burn another inference call.
const NO_RETRY_PREFIXES = ["daily", "gap:", "broadcast disabled", "no OpenTweet", "opentweet"];

export function isRetryableDrop(reason: string): boolean {
  return !NO_RETRY_PREFIXES.some((p) => reason.startsWith(p));
}

function d1Ports(env: Env, cfg: RuntimeConfig): CadencePorts {
  const db = env.DB;
  return {
    store: xStore(db),
    selfSentToday: (day) => countXSelfSentToday(db, day),
    schedule: () => getXSchedule(db),
    setSchedule: (nextIso, gap, at) => setXSchedule(db, nextIso, gap, at),
    pickCorpus: async (args) => {
      const { sql, params } = buildPickQuery(args);
      const row = await db.prepare(sql).bind(...params).first<CorpusRow>();
      return row ?? null;
    },
    markCorpusUsed: (id, at) => markCorpusUsed(db, id, at),
    recentAngles: (n) => recentXAngles(db, n),
    spentToday: (day) => spendTodayUsd(db, day),
    generateProse: ({ corpus, angle }) => generateBroadcastProse(env, cfg, { corpus, angle }),
  };
}

// Generate the ③ prose with one model call. Uses the wallet key ONLY to pay BlockRun for
// inference (same as a heartbeat); the key never reaches the posting path.
export async function generateBroadcastProse(
  env: Env,
  cfg: RuntimeConfig,
  input: { corpus: CorpusPick | null; angle: { key: string; instruction: string } },
): Promise<string> {
  const recentPosts = (await recentXPosts(env.DB, 10).catch(() => [])).map((r) => r.text);
  const recentRows = await recentDarkroom(env.DB, 5).catch(() => []);
  const recentNarrations = recentRows
    .map((r: { narration?: unknown }) => String(r?.narration ?? "").trim())
    .filter(Boolean)
    .reverse();
  const prompt = buildBroadcastPrompt({
    officialHandle: cfg.xOfficialHandle,
    recentPosts,
    recentNarrations,
    corpus: input.corpus,
    angle: input.angle,
  });
  const client = new LLMClient({ privateKey: cfg.walletKey as `0x${string}` });
  const resp = await client.chatCompletion(
    cfg.model,
    [{ role: "user" as const, content: prompt }],
    // JSON mode, exactly like the heartbeat. Without it this model spends the whole completion
    // budget reasoning and returns finish_reason="length" with empty content (caught in
    // pre-flight: 6/6 empty at maxTokens 150, then 2/6 empty and one cut mid-sentence at 600).
    // 600 matches the heartbeat, which produces full-length output reliably in this mode.
    { responseFormat: { type: "json_object" }, temperature: 0.9, maxTokens: 600 },
  );
  const choice = resp.choices?.[0];
  // A truncated completion is worse than no completion: it would post a half sentence. Treat it
  // as empty so the caller retries with different material instead of publishing a fragment.
  if (choice?.finish_reason === "length") return "";
  const raw = choice?.message?.content ?? "";
  // Tolerant parse: the model may still wrap the object in fences or add a stray word.
  try {
    const parsed = parseJson(raw);
    const tweet = typeof parsed?.tweet === "string" ? parsed.tweet : "";
    if (tweet.trim()) return cleanTweetText(tweet);
  } catch {
    // fall through to the raw text below
  }
  return cleanTweetText(raw);
}

export async function maybeCadencePost(env: Env, deps: CadenceDeps = {}): Promise<BroadcastOutcome> {
  const cfg = readConfig(env);
  if (!cfg.xBroadcastEnabled) return { skipped: "broadcast disabled" };
  if (!cfg.openTweetApiKey) return { skipped: "no OpenTweet key (disarmed)" };

  const base = d1Ports(env, cfg);
  const ports: CadencePorts = { ...base, ...(deps.ports ?? {}) };
  // An injected generator needs no wallet key; the real one pays BlockRun with it.
  if (!deps.ports?.generateProse && !cfg.walletKey) return { skipped: "no wallet key (cannot generate)" };

  const now = (deps.now ?? (() => new Date()))();
  const day = now.toISOString().slice(0, 10);
  const random = deps.random ?? Math.random;

  // Cheap pre-checks first: a tick that cannot post must not cost an inference call.
  const sentAll = await ports.store.countXSentAllToday(day);
  if (sentAll >= cfg.xGlobalMaxPerDay) return { skipped: `daily plan cap reached (${sentAll}/${cfg.xGlobalMaxPerDay})` };
  const selfSent = await ports.selfSentToday(day);
  if (selfSent >= cfg.xPostMaxPerDay) return { skipped: `daily self-post cap reached (${selfSent})` };
  const spent = await ports.spentToday(day);
  if (spent >= cfg.dailyBudgetUsd) return { skipped: "daily budget reached" };

  // Rhythm: the schedule row is the single source of "may I speak now". Catch-up does not
  // bypass it — a shorter gap was already drawn after the previous post, so the floor is
  // recovered smoothly instead of in a burst.
  const sched = await ports.schedule();
  const due = Date.parse(sched.next_eligible_at);
  if (Number.isFinite(due) && now.getTime() < due) {
    return { skipped: `waiting until ${sched.next_eligible_at}` };
  }

  const cooldownCutoff = new Date(now.getTime() - cfg.xCorpusCooldownDays * 86_400_000).toISOString();
  const topicCutoff = new Date(now.getTime() - cfg.xCorpusTopicHours * 3_600_000).toISOString();
  const angle = pickAngle(await ports.recentAngles(cfg.xPostRetryMax + 3));

  const excludeIds: number[] = [];
  let lastOutcome: BroadcastOutcome = null;

  // A failed attempt must still move the schedule forward. Without this, a rail that keeps
  // failing (the model returning empty, OpenTweet erroring, a run of gate drops) would retry on
  // every 15-minute tick: up to 96 rounds x 3 generations a day of wasted spend plus needless
  // hammering of the posting API. The backoff still recovers within the hour if the cause was
  // transient, and the daily budget cap remains the outer stop.
  const backoff = async (outcome: BroadcastOutcome): Promise<BroadcastOutcome> => {
    await ports
      .setSchedule(new Date(now.getTime() + cfg.xFailBackoffMinutes * 60_000).toISOString(), null, now.toISOString())
      .catch(() => {});
    return outcome;
  };

  for (let attempt = 0; attempt <= cfg.xPostRetryMax; attempt++) {
    const corpus = await ports.pickCorpus({ cooldownCutoffIso: cooldownCutoff, topicCutoffIso: topicCutoff, excludeIds });
    // A throw here is expected eventually — an empty wallet makes the inference payment fail —
    // and an exception escaping the loop would skip the backoff and put us straight back into a
    // retry-every-tick loop. Funnel it into the same bounded path as a refused draft.
    let prose = "";
    let result: PostResult | null = null;
    try {
      prose = await ports.generateProse({ corpus, angle });
      if (prose) {
        result = await postTweet(
          broadcastConfig(cfg),
          ports.store,
          {
            prose,
            trigger: "cadence",
            corpusId: corpus?.id ?? null,
            angle: angle.key,
            ref: corpus ? `corpus-${corpus.id}` : null,
          },
          deps,
        );
      }
    } catch (e) {
      lastOutcome = { skipped: `generation or posting threw: ${(e as Error)?.message ?? e}` };
      if (corpus) excludeIds.push(corpus.id);
      continue;
    }
    if (!prose) {
      lastOutcome = { skipped: "empty generation" };
      if (corpus) excludeIds.push(corpus.id);
      continue;
    }
    if (!result) continue;
    lastOutcome = result;
    if (result.posted) {
      // Stamp the material only on a real send, so an unlucky run of dropped drafts does not
      // burn the library without publishing anything.
      if (corpus) await ports.markCorpusUsed(corpus.id, now.toISOString()).catch(() => {});
      const sentSoFar = selfSent + 1;
      const gap = drawGapMinutes(
        { min: cfg.xGapMinMinutes, max: cfg.xGapMaxMinutes, behind: cfg.xBehindGapMinutes },
        {
          behind: isBehindPace(sentSoFar, cfg.xPostMinPerDay, now),
          remaining: cfg.xPostMinPerDay - sentSoFar,
          hoursLeft: hoursLeftInUtcDay(now),
        },
        random,
      );
      await ports
        .setSchedule(new Date(now.getTime() + gap * 60_000).toISOString(), gap, now.toISOString())
        .catch(() => {});
      return result;
    }
    if (!isRetryableDrop(result.reason)) return await backoff(result);
    // A content-side drop means this material or this wording was refused: exclude the excerpt
    // and try again with something else, which is what keeps the daily floor reachable.
    if (corpus) excludeIds.push(corpus.id);
  }
  return await backoff(lastOutcome ?? { skipped: "no attempt made" });
}

// ---------------------------------------------------------------------------
// Corpus ingest — the slow "reading" cron. Kept off the posting path on purpose.
// ---------------------------------------------------------------------------

export async function maybeIngestCorpus(
  env: Env,
  opts: { fetchImpl?: FetchImpl; now?: () => Date; maxTopics?: number } = {},
): Promise<IngestResult> {
  const cfg = readConfig(env);
  const empty: IngestResult = { fetched: 0, stored: 0, rejected: 0, duplicate: 0, errors: [], topics: [], total: 0 };
  if (!cfg.xBroadcastEnabled) return { ...empty, skipped: "broadcast disabled" };
  return ingestCorpus(
    corpusStore(env.DB),
    { corpusTarget: cfg.xCorpusTarget, perTopicTarget: cfg.xCorpusPerTopic, secrets: secretValues(cfg) },
    {
      fetchImpl: opts.fetchImpl ?? fetch,
      now: opts.now,
      maxTopics: opts.maxTopics ?? cfg.xCorpusTopicsPerRun,
    },
  );
}

// ① fire after a mission is published. Best-effort: never throws into the caller's flow.
export async function broadcastPublish(env: Env, missionId: number, deps: XTweetDeps = {}): Promise<BroadcastOutcome> {
  try {
    const cfg = readConfig(env);
    if (!cfg.xBroadcastEnabled || !cfg.openTweetApiKey) return null; // inert
    const m = await getMission(env.DB, missionId);
    if (!m) return null;
    const { prose, suffix } = composePublishTweet(m);
    return await postTweet(broadcastConfig(cfg), xStore(env.DB), { prose, suffix, trigger: "publish", ref: `mission-${missionId}` }, deps);
  } catch (e) {
    console.error("broadcastPublish failed:", (e as Error).message);
    return null;
  }
}

// ② fire after a mission settles on-chain. Best-effort: never throws into the payment flow.
export async function broadcastSettlement(env: Env, missionId: number, txHash: string, deps: XTweetDeps = {}): Promise<BroadcastOutcome> {
  try {
    const cfg = readConfig(env);
    if (!cfg.xBroadcastEnabled || !cfg.openTweetApiKey || !txHash) return null; // inert
    const m = await getMission(env.DB, missionId);
    if (!m) return null;
    const { prose, suffix } = composeSettlementTweet(m, txHash);
    return await postTweet(broadcastConfig(cfg), xStore(env.DB), { prose, suffix, trigger: "settlement", ref: `mission-${missionId}` }, deps);
  } catch (e) {
    console.error("broadcastSettlement failed:", (e as Error).message);
    return null;
  }
}
