// Env binding + var parsing for the MIND worker.
// Secrets (HOLO_WALLET_KEY, HOLO_MASTER_KEY, CREATOR_TOKEN) are NEVER in wrangler.toml;
// they are undefined until deliberately set with `wrangler secret put`. The code treats
// a missing secret as "disarmed" and refuses to spend.

import { parseRpcList } from "./rpc.js";

export interface Env {
  // D1 (the mind's own isolated store)
  DB: D1Database;

  // Service binding to the BODY worker (holotype-dev). In-platform, no public HTTP hop.
  // Optional: absent in local `wrangler dev` unless bound, so observe() falls back to fetch().
  BODY?: Fetcher;

  // Plain vars (wrangler.toml [vars])
  BODY_WORKER_URL: string;
  MODEL: string;
  HEARTBEAT_ENABLED: string; // "true" | "false" — global kill switch
  DAILY_BUDGET_USD: string;
  PER_BEAT_CAP_USD: string;
  PER_CALL_FEE_USD: string;
  PRIVATE_CONTEXT_N: string;
  MODULATORY_TOPK: string; // how many modulatory neurons a thought maps onto; <=0 = whole layer
  NECTAR_MAX_PER_DAY?: string; // hard cap on new Nectar missions per UTC day (default 5)
  NECTAR_MAX_PER_MISSION_USD?: string; // hard cap on one mission's reward (default 1)
  NECTAR_AUTO_SETTLE?: string; // "true" lets Holo review+pay a submitted delivery on its own (default false = creator-gated)
  // x402 buyer rail caps — SEPARATE from the vanilla Nectar caps above (different payment
  // path: EIP-3009 buyer signature vs a plain on-chain transfer). Both default to $1/purchase
  // and 5 purchases/UTC day.
  X402_MAX_PER_PURCHASE_USD?: string; // hard cap on ONE x402 buyer purchase (default 1)
  X402_MAX_PER_DAY?: string; // hard cap on x402 purchases per UTC day (default 5)
  X402_MAX_TIMEOUT_SECONDS?: string; // longest validity window we will sign (default 300; seller may bound it lower)

  // X (Twitter) self-broadcast rail — Holo runs its own account via OpenTweet. Disarmed by
  // default: with X_BROADCAST_ENABLED != "true" OR no OPENTWEET_API_KEY, nothing is posted.
  X_BROADCAST_ENABLED?: string; // "true" | "false" — broadcast kill switch (default false)
  X_POST_MIN_PER_DAY?: string; // floor: self-posts the rail must reach per UTC day (default 12)
  X_POST_MAX_PER_DAY?: string; // ceiling on self-posts per UTC day (default 18)
  X_GLOBAL_MAX_PER_DAY?: string; // ceiling on ALL kinds per UTC day (default 20 = the plan limit)
  X_GAP_MIN_MINUTES?: string; // shortest random gap between two self-posts (default 40)
  X_GAP_MAX_MINUTES?: string; // longest random gap between two self-posts (default 120)
  X_BEHIND_GAP_MINUTES?: string; // gap used when the day is behind pace (default 20)
  X_POST_RETRY_MAX?: string; // extra attempts when a draft is dropped (default 2)
  X_FAIL_BACKOFF_MINUTES?: string; // how long to wait after a FAILED attempt (default 60)
  X_CORPUS_TARGET?: string; // corpus size the ingest cron fills to (default 600)
  X_CORPUS_PER_TOPIC?: string; // per-topic corpus size ingest aims for (default 24)
  X_CORPUS_COOLDOWN_DAYS?: string; // days before an excerpt may be reused (default 14)
  X_CORPUS_TOPIC_HOURS?: string; // hours before a topic may be used again (default 24)
  X_CORPUS_TOPICS_PER_RUN?: string; // topics fetched per ingest run (default 2; worst case 16 subrequests)
  X_REPLY_MAX_PER_DAY?: string; // hard cap on replies per UTC day (default 12)
  X_POST_MAX_CHARS?: string; // character bound for one self-post (default 1500; the account is verified, so long-form is allowed)
  X_BROADCAST_MAX_TOKENS?: string; // completion budget for one self-post generation (default 3000; must fit the model's reasoning plus the post)
  X_OFFICIAL_HANDLE?: string; // the account Holo runs / may read (default @ArcHolotype)
  TOKEN_CA?: string; // public token contract address, allowed in public text alongside the wallet
  OPENTWEET_BASE_URL?: string; // OpenTweet base url (default https://opentweet.io); overridable for a local dry-run mock

  // Public on-chain read surface (all public info; the wallet address is Holo's own)
  PUBLIC_WALLET_ADDRESS?: string;
  BASE_RPC_URL?: string;
  ARC_RPC_URL?: string;
  ARC_NATIVE_DECIMALS?: string; // Arc's native gas token is USDC; no on-chain decimals() to ask

  // Secrets (absent until armed)
  HOLO_WALLET_KEY?: string; // Base wallet private key (0x…)
  HOLO_MASTER_KEY?: string; // 32-byte AES-GCM key, 64 hex chars
  CREATOR_TOKEN?: string; // admin token gating /creator + /darkroom
  OPENTWEET_API_KEY?: string; // OpenTweet ot_ key for the X broadcast rail; absent = disarmed (no posting)
  BASE_RPC_URL_PRIVATE?: string; // paid RPC endpoint, overrides BASE_RPC_URL when set
  ARC_RPC_URL_PRIVATE?: string; // paid RPC endpoint, overrides ARC_RPC_URL when set
}

function withTail(urls: string[], tail: string): string[] {
  return urls.includes(tail) ? urls : [...urls, tail];
}

export const asBool = (v: string | undefined, dflt = false): boolean =>
  v === undefined ? dflt : v.trim().toLowerCase() === "true";

export const asNum = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

// Runtime config derived from Env with safe defaults.
export interface RuntimeConfig {
  bodyWorkerUrl: string;
  model: string;
  heartbeatEnabled: boolean;
  dailyBudgetUsd: number;
  perBeatCapUsd: number;
  perCallFeeUsd: number;
  privateContextN: number;
  modulatoryTopK: number;
  nectarMaxPerDay: number;
  nectarMaxPerMissionCents: number;
  nectarAutoSettle: boolean;
  x402MaxPerPurchaseCents: number;
  x402MaxPerDay: number;
  x402MaxTimeoutSeconds: number;
  xBroadcastEnabled: boolean;
  xPostMinPerDay: number;
  xPostMaxPerDay: number;
  xGlobalMaxPerDay: number;
  xGapMinMinutes: number;
  xGapMaxMinutes: number;
  xBehindGapMinutes: number;
  xPostRetryMax: number;
  xFailBackoffMinutes: number;
  xCorpusTarget: number;
  xCorpusPerTopic: number;
  xCorpusCooldownDays: number;
  xCorpusTopicHours: number;
  xCorpusTopicsPerRun: number;
  xReplyMaxPerDay: number;
  xPostMaxChars: number;
  xBroadcastMaxTokens: number;
  xOfficialHandle: string;
  tokenCa: string;
  openTweetBaseUrl: string;
  openTweetApiKey?: string;
  walletKey?: string;
  masterKeyHex?: string;
  creatorToken?: string;
  publicWallet: string;
  baseRpcUrls: string[];
  arcRpcUrls: string[];
  arcNativeDecimals: number;
}

export function readConfig(env: Env): RuntimeConfig {
  return {
    bodyWorkerUrl: env.BODY_WORKER_URL ?? "https://holotype-dev.archolotype.workers.dev",
    model: env.MODEL ?? "openai/gpt-4.1-mini",
    heartbeatEnabled: asBool(env.HEARTBEAT_ENABLED, false),
    dailyBudgetUsd: asNum(env.DAILY_BUDGET_USD, 30),
    perBeatCapUsd: asNum(env.PER_BEAT_CAP_USD, 1),
    perCallFeeUsd: asNum(env.PER_CALL_FEE_USD, 0.001),
    privateContextN: Math.max(0, Math.floor(asNum(env.PRIVATE_CONTEXT_N, 8))),
    modulatoryTopK: Math.floor(asNum(env.MODULATORY_TOPK, 10)),
    nectarMaxPerDay: Math.max(1, Math.floor(asNum(env.NECTAR_MAX_PER_DAY, 5))),
    nectarMaxPerMissionCents: Math.max(1, Math.round(asNum(env.NECTAR_MAX_PER_MISSION_USD, 1) * 100)),
    nectarAutoSettle: asBool(env.NECTAR_AUTO_SETTLE, false),
    x402MaxPerPurchaseCents: Math.max(1, Math.round(asNum(env.X402_MAX_PER_PURCHASE_USD, 1) * 100)),
    x402MaxPerDay: Math.max(1, Math.floor(asNum(env.X402_MAX_PER_DAY, 5))),
    x402MaxTimeoutSeconds: Math.max(1, Math.floor(asNum(env.X402_MAX_TIMEOUT_SECONDS, 300))),
    xBroadcastEnabled: asBool(env.X_BROADCAST_ENABLED, false),
    xPostMinPerDay: Math.max(0, Math.floor(asNum(env.X_POST_MIN_PER_DAY, 12))),
    xPostMaxPerDay: Math.max(1, Math.floor(asNum(env.X_POST_MAX_PER_DAY, 18))),
    xGlobalMaxPerDay: Math.max(1, Math.floor(asNum(env.X_GLOBAL_MAX_PER_DAY, 20))),
    xGapMinMinutes: Math.max(1, Math.floor(asNum(env.X_GAP_MIN_MINUTES, 40))),
    xGapMaxMinutes: Math.max(1, Math.floor(asNum(env.X_GAP_MAX_MINUTES, 120))),
    xBehindGapMinutes: Math.max(1, Math.floor(asNum(env.X_BEHIND_GAP_MINUTES, 20))),
    xPostRetryMax: Math.max(0, Math.floor(asNum(env.X_POST_RETRY_MAX, 2))),
    xFailBackoffMinutes: Math.max(1, Math.floor(asNum(env.X_FAIL_BACKOFF_MINUTES, 60))),
    xCorpusTarget: Math.max(1, Math.floor(asNum(env.X_CORPUS_TARGET, 600))),
    xCorpusPerTopic: Math.max(1, Math.floor(asNum(env.X_CORPUS_PER_TOPIC, 24))),
    xCorpusCooldownDays: Math.max(0, asNum(env.X_CORPUS_COOLDOWN_DAYS, 14)),
    xCorpusTopicHours: Math.max(0, asNum(env.X_CORPUS_TOPIC_HOURS, 24)),
    xCorpusTopicsPerRun: Math.max(1, Math.floor(asNum(env.X_CORPUS_TOPICS_PER_RUN, 2))),
    xReplyMaxPerDay: Math.max(0, Math.floor(asNum(env.X_REPLY_MAX_PER_DAY, 12))),
    xPostMaxChars: Math.max(1, Math.floor(asNum(env.X_POST_MAX_CHARS, 1500))),
    xBroadcastMaxTokens: Math.max(1, Math.floor(asNum(env.X_BROADCAST_MAX_TOKENS, 3000))),
    xOfficialHandle: (env.X_OFFICIAL_HANDLE ?? "@ArcHolotype").trim(),
    tokenCa: (env.TOKEN_CA ?? "0xECa7C682fbb32EC4F1B3bBb28791Fe184D3552A8").trim().toLowerCase(),
    openTweetBaseUrl: (env.OPENTWEET_BASE_URL ?? "https://opentweet.io").trim(),
    openTweetApiKey: env.OPENTWEET_API_KEY?.trim() || undefined,
    walletKey: env.HOLO_WALLET_KEY?.trim() || undefined,
    masterKeyHex: env.HOLO_MASTER_KEY?.trim() || undefined,
    creatorToken: env.CREATOR_TOKEN?.trim() || undefined,
    publicWallet: (env.PUBLIC_WALLET_ADDRESS ?? "0xfd644825d074015bed978cb1472bb4b6c1145b06").trim().toLowerCase(),
    baseRpcUrls: withTail(parseRpcList(env.BASE_RPC_URL_PRIVATE, env.BASE_RPC_URL), "https://mainnet.base.org"),
    arcRpcUrls: withTail(parseRpcList(env.ARC_RPC_URL_PRIVATE, env.ARC_RPC_URL), "https://rpc.mainnet.arc.io"),
    arcNativeDecimals: asNum(env.ARC_NATIVE_DECIMALS, 6),
  };
}
