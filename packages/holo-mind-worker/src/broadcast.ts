// X (Twitter) broadcast orchestration — the worker-controlled rail that decides WHEN Holo
// speaks and WHAT factual suffix to attach. Three triggers:
//   ① publish    — a Nectar mission was published (deterministic template, no model call)
//   ② settlement — a mission was paid on-chain (deterministic template + tx/evidence suffix)
//   ③ cadence    — every N hours Holo posts a fresh thought of its own (one model call)
//
// ISOLATION: this rail never sends the wallet key to OpenTweet. The key is used only to pay
// BlockRun for the ③ inference (exactly as every heartbeat does); the posting itself goes
// through xtweet.ts with the OpenTweet ot_ key only. Every outbound text passes the
// fail-closed gate in xtweet.ts (disclosure + identity + dedup + similarity + cadence + caps).
// The whole rail is inert unless X_BROADCAST_ENABLED is true AND an OpenTweet key is set.

import { LLMClient } from "@blockrun/llm";
import { readConfig, type Env, type RuntimeConfig } from "./config.js";
import { buildBroadcastPrompt } from "./prompt.js";
import { broadcastConfig, postTweet, type PostResult, type XPostStore, type XTweetDeps } from "./xtweet.js";
import {
  countXSentSince,
  getMission,
  lastXSentAt,
  recentDarkroom,
  recentXHashes,
  recentXPosts,
  recentXTexts,
  recordXPost,
  spendTodayUsd,
  type MissionRow,
} from "./store.js";

export type BroadcastOutcome = PostResult | { skipped: string } | null;

// Bind the D1 store to the XPostStore port the gate expects.
function xStore(db: D1Database): XPostStore {
  return {
    countXSentSince: (day, kind) => countXSentSince(db, day, kind),
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

// Generate the ③ cadence prose with one model call. Uses the wallet key ONLY to pay BlockRun
// for inference (same as a heartbeat); the key never reaches the posting path.
export async function generateBroadcastProse(env: Env, cfg: RuntimeConfig): Promise<string> {
  const recentPosts = (await recentXPosts(env.DB, 8).catch(() => [])).map((r) => r.text);
  const recentRows = await recentDarkroom(env.DB, 5).catch(() => []);
  const recentNarrations = recentRows
    .map((r: { narration?: unknown }) => String(r?.narration ?? "").trim())
    .filter(Boolean)
    .reverse();
  const prompt = buildBroadcastPrompt({
    officialHandle: cfg.xOfficialHandle,
    recentPosts,
    recentNarrations,
  });
  const client = new LLMClient({ privateKey: cfg.walletKey as `0x${string}` });
  const resp = await client.chatCompletion(
    cfg.model,
    [{ role: "user" as const, content: prompt }],
    { temperature: 0.9, maxTokens: 150 },
  );
  return cleanTweetText(resp.choices?.[0]?.message?.content ?? "");
}

// Test/dry-run seams: inject a store, a prose generator, and today's spend so the cadence
// path can be exercised end-to-end without a real D1, a real model call, or any spend.
export interface BroadcastOverrides {
  store?: XPostStore;
  generateProse?: (env: Env, cfg: RuntimeConfig) => Promise<string>;
  spentTodayUsd?: number;
}

// ③ cadence post — fired from the cron handler every tick; self-guards so it only actually
// posts when enabled, armed, past the interval, under the daily cap, and within budget. The
// cadence/cap checks run BEFORE the model call so a not-due tick costs nothing.
export async function maybeCadencePost(env: Env, deps: XTweetDeps = {}, overrides: BroadcastOverrides = {}): Promise<BroadcastOutcome> {
  const cfg = readConfig(env);
  if (!cfg.xBroadcastEnabled) return { skipped: "broadcast disabled" };
  if (!cfg.openTweetApiKey) return { skipped: "no OpenTweet key (disarmed)" };
  const gen = overrides.generateProse ?? generateBroadcastProse;
  // A real generation needs the wallet key to pay BlockRun; an injected generator does not.
  if (!overrides.generateProse && !cfg.walletKey) return { skipped: "no wallet key (cannot generate)" };

  const store = overrides.store ?? xStore(env.DB);
  const now = (deps.now ?? (() => new Date()))();
  const day = now.toISOString().slice(0, 10);

  // Cheap pre-checks (avoid a wasted model call when not due).
  const last = await store.lastXSentAt("post");
  if (last) {
    const elapsedH = (now.getTime() - new Date(last).getTime()) / 3_600_000;
    if (elapsedH < cfg.xPostIntervalHours) return { skipped: `cadence ${elapsedH.toFixed(1)}h < ${cfg.xPostIntervalHours}h` };
  }
  const postsToday = await store.countXSentSince(day, "post");
  if (postsToday >= cfg.xPostMaxPerDay) return { skipped: "daily post cap reached" };

  // Inference spend still counts against the daily budget.
  const spent = overrides.spentTodayUsd ?? (await spendTodayUsd(env.DB, day));
  if (spent >= cfg.dailyBudgetUsd) return { skipped: "daily budget reached" };

  const prose = await gen(env, cfg);
  if (!prose) return { skipped: "empty generation" };
  return postTweet(broadcastConfig(cfg), store, { prose, trigger: "cadence" }, deps);
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
