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
  NECTAR_MAX_PER_DAY?: string; // hard cap on new Nectar missions per UTC day (default 3)
  NECTAR_MAX_PER_MISSION_USD?: string; // hard cap on one mission's reward (default 5)

  // Public on-chain read surface (all public info; the wallet address is Holo's own)
  PUBLIC_WALLET_ADDRESS?: string;
  BASE_RPC_URL?: string;
  ARC_RPC_URL?: string;
  ARC_NATIVE_DECIMALS?: string; // Arc's native gas token is USDC; no on-chain decimals() to ask

  // Secrets (absent until armed)
  HOLO_WALLET_KEY?: string; // Base wallet private key (0x…)
  HOLO_MASTER_KEY?: string; // 32-byte AES-GCM key, 64 hex chars
  CREATOR_TOKEN?: string; // admin token gating /creator + /darkroom
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
    nectarMaxPerDay: Math.max(1, Math.floor(asNum(env.NECTAR_MAX_PER_DAY, 3))),
    nectarMaxPerMissionCents: Math.max(1, Math.round(asNum(env.NECTAR_MAX_PER_MISSION_USD, 5) * 100)),
    walletKey: env.HOLO_WALLET_KEY?.trim() || undefined,
    masterKeyHex: env.HOLO_MASTER_KEY?.trim() || undefined,
    creatorToken: env.CREATOR_TOKEN?.trim() || undefined,
    publicWallet: (env.PUBLIC_WALLET_ADDRESS ?? "0xfd644825d074015bed978cb1472bb4b6c1145b06").trim().toLowerCase(),
    baseRpcUrls: withTail(parseRpcList(env.BASE_RPC_URL_PRIVATE, env.BASE_RPC_URL), "https://mainnet.base.org"),
    arcRpcUrls: withTail(parseRpcList(env.ARC_RPC_URL_PRIVATE, env.ARC_RPC_URL), "https://rpc.mainnet.arc.io"),
    arcNativeDecimals: asNum(env.ARC_NATIVE_DECIMALS, 6),
  };
}
