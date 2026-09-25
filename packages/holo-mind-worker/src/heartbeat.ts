// One Holo heartbeat, Worker edition.
//   guards -> observe body /state -> LLM {narration,intent} -> deterministic policy
//   -> record to the isolated darkroom (with exact cost) -> daily budget enforced.
//
// THREE guards run BEFORE any money can move:
//   1. kill switch  — HEARTBEAT_ENABLED must be "true".
//   2. disarmed     — no HOLO_WALLET_KEY => cannot sign => refuse to call the LLM.
//   3. daily budget — if today's recorded spend already >= DAILY_BUDGET_USD, skip.
// Output is bounded (maxTokens) so a single beat can never blow the per-beat cap.

import { LLMClient } from "@blockrun/llm";
import { readConfig, type Env } from "./config.js";
import { loadMasterKey } from "./crypto.js";
import { buildPrompt, parseJson, extractNarration, type Observed } from "./prompt.js";
import { decide, type Intent, type Verdict } from "./policy.js";
import { syncTxHashes } from "./evidence.js";
import { readUsdcBalances } from "./rpc.js";
import { readWorldDigest } from "./sensors.js";
import { broadcastPublish } from "./broadcast.js";
import {
  recordDarkroom,
  countDarkroom,
  spendTodayUsd,
  recentPrivate,
  recentDarkroom,
  createMission,
  countMissionsSince,
  sumReservedTodayCents,
} from "./store.js";
import { discloseGate, secretValues } from "./disclose.js";

export interface BeatResult {
  status: "ok" | "skipped" | "error";
  reason?: string;
  id?: number;
  total?: number;
  observed?: Observed;
  model?: string;
  narration?: string;
  intent?: Intent;
  verdict?: Verdict;
  costUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  parseErr?: string | null;
  costOverCap?: boolean; // true if this beat's real cost hit/exceeded PER_BEAT_CAP_USD
  // Coupling stage ① (light up the front end, A2): the modulatory-layer neuron indices this thought mapped onto.
  // null when the body snapshot was unavailable this beat (mapping is best-effort).
  neuronIndices?: number[] | null;
  modulatoryTotal?: number | null; // how many modulatory neurons exist (the pool we picked from)
  neuronCount?: number | null; // total neurons in the connectome snapshot
}

// Read Holo's embodied state off the BODY worker (read-only, no money).
// Prefers the in-platform service binding (env.BODY) over a public HTTP fetch:
// worker→worker subrequests to *.workers.dev were returning 404 even though the
// same URL is 200 publicly, so we route directly via the binding when present.
async function observe(env: Env, baseUrl: string): Promise<Observed> {
  const base = baseUrl.replace(/\/+$/, ""); // strip trailing slash(es): body router 404s on //state
  const url = `${base}/state`;
  const r = env.BODY ? await env.BODY.fetch(new Request(url)) : await fetch(url);
  if (!r.ok) throw new Error(`body /state ${r.status} @ ${url}`);
  const s: any = await r.json();
  const c = s.collective ?? {};
  const top = (obj: any): [string, number] | undefined =>
    Object.entries(obj ?? {}).sort((a, b) => (b[1] as number) - (a[1] as number))[0] as
      | [string, number]
      | undefined;
  return {
    tickIndex: s.tickIndex ?? null,
    temperature: c.temperature ?? s.market?.temperature ?? null,
    regime: c.regime ?? s.market?.regime ?? null,
    arousal: c.arousal ?? null,
    valence: c.valence ?? null,
    cohesion: c.cohesion ?? null,
    behavior: top(c.states)?.[0] ?? null,
    fap: top(c.faps)?.[0] ?? null,
    balanceUsdc: s.economy?.meanBalanceUsdc ?? null,
  };
}

// Public, best-effort read of the market temperature for the site's temperature
// bar. Never throws and never blocks the endpoint: if the BODY worker is
// unreachable every field comes back null, so the caller renders its "waiting
// for a reading" fallback instead of a stale or invented number.
export interface MarketReading {
  temperature: number | null; // 0..1, relative to the token's own recent norm
  regime: string | null; // "HOT" | "CALM" | "COLD"
  volumeUsd: number | null; // 24h quote-side volume behind the reading
  trades: number | null; // 24h trade count behind the reading
  source: string | null; // "token-volume" | "arc-activity"
  // The body worker's live collective neural snapshot (read-only passthrough).
  // Null when the body is unreachable so callers keep their fallbacks.
  neural: {
    arousal: number | null;
    cohesion: number | null;
    rest: number | null;
    wingbeat: number | null;
    valence: number | null;
    vitality: number | null;
  } | null;
}
// Coarse public projection of this beat's private intent: enough for the Colony to show
// what the brain is currently geared toward, without exposing the raw intent payload.
// Fail-closed: anything unparseable or unknown yields null.
export function driveOf(intentJson: string | null): string | null {
  try {
    const parsed = intentJson ? JSON.parse(intentJson) : null;
    const raw = parsed && typeof parsed.type === "string" ? parsed.type : parsed && typeof parsed.intent === "string" ? parsed.intent : null;
    if (raw === "rest") return "rest";
    if (raw === "reflect") return "reflect";
    if (raw === "observe" || raw === "narrate") return "observe";
    if (raw === "idle") return "idle";
    return null;
  } catch {
    return null;
  }
}

export async function readMarket(env: Env, baseUrl: string): Promise<MarketReading> {
  const empty: MarketReading = {
    temperature: null,
    regime: null,
    volumeUsd: null,
    trades: null,
    source: null,
    neural: null,
  };
  try {
    const base = baseUrl.replace(/\/+$/, "");
    const url = `${base}/state`;
    const r = env.BODY ? await env.BODY.fetch(new Request(url)) : await fetch(url);
    if (!r.ok) return empty;
    const s: any = await r.json();
    const m = s.market ?? {};
    const c = s.collective ?? {};
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    return {
      temperature: num(m.temperature ?? c.temperature),
      regime: str(m.regime ?? c.regime),
      volumeUsd: num(m.value),
      trades: num(m.breadth),
      source: str(m.source),
      neural: {
        arousal: num(c.arousal),
        cohesion: num(c.cohesion),
        rest: num(c.rest),
        wingbeat: num(c.wingbeat),
        valence: num(c.valence),
        vitality: num(c.vitality),
      },
    };
  } catch {
    return empty;
  }
}

// Per-neuron read-out of one fly off the BODY worker (GET /snapshot?flyId=N), used to map
// a thought onto specific connectome nodes. Best-effort and FREE: it rides the same service
// binding as observe(), and any failure returns null so it can NEVER break a heartbeat.
interface NeuronRead {
  kinds: string[];
  membrane: number[]; // graded subthreshold potential — the modulatory layer's real signal
  count: number;
}
async function observeNeurons(env: Env, baseUrl: string, flyId: number): Promise<NeuronRead | null> {
  try {
    const base = baseUrl.replace(/\/+$/, "");
    const url = `${base}/snapshot?flyId=${flyId}`;
    const r = env.BODY ? await env.BODY.fetch(new Request(url)) : await fetch(url);
    if (!r.ok) return null;
    const s: any = await r.json();
    const kinds: string[] = Array.isArray(s.neuronKinds) ? s.neuronKinds : [];
    const membrane: number[] = Array.isArray(s.membrane) ? s.membrane : [];
    if (!kinds.length) return null;
    return { kinds, membrane, count: Number(s.neuronCount ?? kinds.length) };
  } catch {
    return null; // missing/unreadable snapshot must never fail the beat
  }
}

// A2 mapping: pick the modulatory-layer nodes this thought "lights up". Modulatory neurons
// are slow high-threshold integrators that encode "mood" as GRADED membrane potential and
// essentially never spike (live body: 0/40 have a nonzero firing rate), so we rank them by
// membrane — NOT firing rate, which is identically 0 here and would degenerate to a fixed
// node set. Top-K by membrane gives per-thought differentiation (different thoughts light
// different nodes; newer thoughts gradually cover older ones). K<=0 (or K>=pool) = whole
// layer. Returned ascending by index for stable storage. Pure function — unit-testable.
export function mapModulatory(kinds: string[], membrane: number[], topK: number): number[] {
  const pool: number[] = [];
  for (let i = 0; i < kinds.length; i++) if (kinds[i] === "modulatory") pool.push(i);
  if (topK <= 0 || topK >= pool.length) return pool; // already ascending
  return pool
    .slice()
    .sort((a, b) => (membrane[b] ?? 0) - (membrane[a] ?? 0))
    .slice(0, topK)
    .sort((a, b) => a - b);
}

export async function beat(env: Env, modelOverride?: string): Promise<BeatResult> {
  const cfg = readConfig(env);
  // A creator-supplied ?model= overrides the default for THIS beat only (cron never
  // passes one). Bounded below by the per-beat cap, so it cannot overspend.
  const model = modelOverride?.trim() || cfg.model;

  // Guard 1 — global kill switch.
  if (!cfg.heartbeatEnabled) {
    return { status: "skipped", reason: "kill switch off (HEARTBEAT_ENABLED != true)" };
  }
  // Guard 2 — disarmed: no wallet key means we cannot sign a payment, so we refuse
  // to even call the LLM. (Defence in depth: it cannot spend what it cannot sign.)
  if (!cfg.walletKey) {
    return { status: "skipped", reason: "no HOLO_WALLET_KEY (disarmed); refusing to spend" };
  }
  // Guard 3 — daily budget (pre-call, using recorded spend).
  const day = new Date().toISOString().slice(0, 10);
  const spentToday = await spendTodayUsd(env.DB, day);
  if (spentToday >= cfg.dailyBudgetUsd) {
    return {
      status: "skipped",
      reason: `daily budget reached ($${spentToday.toFixed(4)} >= $${cfg.dailyBudgetUsd})`,
    };
  }

  // Observe the body.
  const o = await observe(env, cfg.bodyWorkerUrl);

  // Feed the prompt Holo's REAL on-chain Base USDC (the money it thinks with), replacing
  // the body's simulated mean balance. Read-only. On read failure we pass null so the
  // prompt shows an unknown balance rather than a fabricated number that could mislead
  // the model about its own funds.
  const balances = await readUsdcBalances({
    baseRpcUrls: cfg.baseRpcUrls,
    arcRpcUrls: cfg.arcRpcUrls,
    wallet: cfg.publicWallet,
    arcNativeDecimals: cfg.arcNativeDecimals,
  }).catch(() => null);
  o.balanceUsdc = balances?.baseUsdc ?? null;

  // Coupling stage ① (light up the front end, A2): map this thought onto Holo's modulatory layer (flyId=0 = Holo).
  // Read-only, free, best-effort — a missing snapshot just yields null indices.
  const neurons = await observeNeurons(env, cfg.bodyWorkerUrl, 0);
  const neuronIndices = neurons
    ? mapModulatory(neurons.kinds, neurons.membrane, cfg.modulatoryTopK)
    : null;
  const modulatoryTotal = neurons
    ? neurons.kinds.reduce((n, k) => (k === "modulatory" ? n + 1 : n), 0)
    : null;

  // Load the creator's private training (decrypted in-process only). Optional: without
  // the master key there is simply no private guidance this beat.
  let privateLines: string[] = [];
  if (cfg.masterKeyHex) {
    const key = await loadMasterKey(cfg.masterKeyHex);
    const recent = await recentPrivate(env.DB, key, cfg.privateContextN);
    privateLines = recent.map((m) => `[${m.role}] ${m.text}`);
  }

  // Memory: feed Holo its own last few narrations so it varies instead of repeating
  // the same imagery every beat. Best-effort — an empty log just means no memory block.
  const recentRows = await recentDarkroom(env.DB, 3).catch(() => []);
  const recentNarrations = recentRows
    .map((r: { narration?: unknown }) => String(r?.narration ?? "").trim())
    .filter(Boolean)
    .reverse(); // oldest -> newest

  // World: real recent changes in the project (public GitHub commits), fenced as
  // untrusted data in the prompt. Optional and cached; null simply omits the section.
  const worldDigest = await readWorldDigest();

  // One LLM call. A FRESH client per beat makes getSpending().totalUsd this beat's cost.
  const client = new LLMClient({ privateKey: cfg.walletKey as `0x${string}` });
  const prompt = buildPrompt(o, privateLines, {
    maxMissionCents: cfg.nectarMaxPerMissionCents,
    recentNarrations,
    worldDigest,
  });
  const resp = await client.chatCompletion(
    model,
    [{ role: "user" as const, content: prompt }],
    // 600 (was 300): the richer prompt (memory + world digest) draws longer, more
    // elaborate narrations, and 300 was truncating the JSON mid-string so it failed to
    // parse. 600 leaves room for the narration plus the intent object to close cleanly,
    // and still bounds a beat far under PER_BEAT_CAP_USD.
    { responseFormat: { type: "json_object" }, temperature: 0.8, maxTokens: 600 },
  );
  const raw = resp.choices?.[0]?.message?.content ?? "";
  const usage = resp.usage;
  const costUsd = Number(client.getSpending?.().totalUsd ?? 0);
  // Per-beat cap is a post-hoc alarm: maxTokens=600 mathematically bounds any model's
  // beat cost far under PER_BEAT_CAP_USD, so this should never trip — but if a future
  // model/price made it trip, we record it loudly rather than hide it.
  const costOverCap = costUsd >= cfg.perBeatCapUsd;

  // Parse (tolerant) -> policy gate (the model only proposes; the gate decides).
  let intent: Intent;
  let narration: string;
  let parseErr: string | null = null;
  // Last-resort cleanup so the public feed never shows a raw JSON fragment.
  const cleanRaw = (s: string) => String(s).replace(/```json|```/g, "").trim().slice(0, 280);
  try {
    const p = parseJson(raw);
    narration = String(p.narration ?? "").trim() || extractNarration(raw) || cleanRaw(raw);
    intent = (p.intent as Intent) ?? { type: "narrate", reason: "model returned no intent" };
  } catch (e) {
    parseErr = (e as Error).message;
    // Truncated/malformed JSON: salvage the narration text itself rather than storing
    // the raw `{"narration":"...` fragment, which would otherwise surface publicly.
    narration = extractNarration(raw) || cleanRaw(raw);
    intent = { type: "narrate", reason: `unparseable JSON (${parseErr})` };
  }
  const verdict: Verdict = decide(intent);

  // Autonomous publishing: Holo may originate a Nectar mission on its own. Publishing
  // needs NO creator approval (it moves no money); the guards are the disclosure gate on
  // the public text plus the code-enforced volume / daily-budget / per-mission caps.
  // Creator approval is still required later for delivery acceptance and for payment.
  if (verdict.decision === "ALLOWED" && intent.type === "publish_mission") {
    try {
      const p = intent as any;
      const title = String(p.title ?? "").trim();
      const description = String(p.description ?? "").trim();
      const criteria = Array.isArray(p.criteria)
        ? p.criteria.map((c: unknown) => String(c).trim()).filter(Boolean)
        : [];
      const rewardCents = Math.floor(Number(p.rewardCents ?? 0));
      const secrets = secretValues(cfg);
      const textOk = [title, description, ...criteria].every(
        (t) => t.length > 0 && discloseGate(t, cfg.publicWallet, secrets).ok,
      );
      const day = new Date().toISOString().slice(0, 10);
      const [spentToday, missionsToday, reservedCents] = await Promise.all([
        spendTodayUsd(env.DB, day),
        countMissionsSince(env.DB, day),
        sumReservedTodayCents(env.DB, day),
      ]);
      const withinCaps =
        rewardCents > 0 &&
        rewardCents <= cfg.nectarMaxPerMissionCents &&
        missionsToday < cfg.nectarMaxPerDay &&
        spentToday + (reservedCents + rewardCents) / 100 <= cfg.dailyBudgetUsd;
      if (textOk && withinCaps && title && description && criteria.length > 0) {
        const newId = await createMission(env.DB, { title, description, criteria, rewardCents, chain: "arc" });
        // ① publish broadcast (inert unless X_BROADCAST_ENABLED + OpenTweet key are set).
        // Best-effort and self-guarding; never fails or delays the beat.
        await broadcastPublish(env, newId);
      }
    } catch (e) {
      // A failed autonomous publish must never fail or delay the beat itself.
      console.error("autonomous publish failed:", (e as Error).message);
    }
  }

  const id = await recordDarkroom(env.DB, {
    tick_index: o.tickIndex,
    temperature: o.temperature,
    regime: o.regime,
    arousal: o.arousal,
    valence: o.valence,
    behavior: o.behavior,
    fap: o.fap,
    model,
    narration,
    intent_json: JSON.stringify(intent),
    policy_decision: verdict.decision,
    policy_reason: verdict.reason,
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    cost_usd: costUsd,
    neuron_indices: neuronIndices ? JSON.stringify(neuronIndices) : null,
  });
  const total = await countDarkroom(env.DB);

  // Link this beat to its on-chain x402 settlement tx (read-only scan). Evidence is
  // best-effort: a failure here must never fail or delay the beat itself.
  try {
    await syncTxHashes(env);
  } catch (e) {
    // leave tx_hash null; the next beat's sync retries
    console.error("syncTxHashes failed:", (e as Error).message);
  }

  return {
    status: "ok",
    id,
    total,
    observed: o,
    model,
    narration,
    intent,
    verdict,
    costUsd,
    promptTokens: usage?.prompt_tokens ?? undefined,
    completionTokens: usage?.completion_tokens ?? undefined,
    parseErr,
    costOverCap,
    neuronIndices,
    modulatoryTotal,
    neuronCount: neurons?.count ?? null,
  };
}
