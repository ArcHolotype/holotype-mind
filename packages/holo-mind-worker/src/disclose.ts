// Disclosure gate for anything that leaves the mind toward public surfaces.
// Fail-closed by construction: an entry that trips ANY gate is dropped whole,
// never truncated or redacted, so a partial leak is not representable.
//
// The gates are technical format/encoding checks applied to the narration text:
//   1. shape      — string, non-empty, bounded length
//   2. encoding   — printable ASCII plus newline only (the public journal is ASCII-set)
//   3. structure  — no URLs or markdown links
//   4. key shape  — long hex runs dropped; 40-hex addresses dropped unless they are
//                   the configured public wallet (balance/spend transparency is intended)
//   5. secret value — the literal text of any configured secret (keys, tokens, RPC
//                   endpoints) drops the entry, covering secrets whose shape is not hex
//   6. reserved   — terms reserved for private operations, vendor self-identification,
//                   or personal context outside the public identity frame
//
// The prompt layer asks the model for English-only output first; this module is the
// hard layer that does not depend on the model complying.

export interface DisclosureVerdict {
  ok: boolean;
  reason: string;
}

// Coupled to the LLM maxTokens in heartbeat.ts (currently 600): a richer prompt draws
// longer narrations, and any beat over this bound is dropped whole from the public feed.
// Observed narrations have been climbing (486 -> 737 chars over a few hours), so 1200
// leaves generous headroom above the current max rather than hugging it. If maxTokens is
// raised again, raise this bound too so long beats are never silently dropped.
const MAX_PUBLIC_CHARS = 1200;

// A configured value must be at least this long to be treated as a secret to match,
// so short or empty config entries cannot accidentally drop ordinary narration.
const MIN_SECRET_LEN = 8;

const RESERVED_TERMS: readonly string[] = [
  // private-operation surface
  "darkroom",
  "private channel",
  "private message",
  "creator token",
  "master key",
  "service binding",
  // internal deployment names
  "workers.dev",
  "holotype-dev",
  "holotype-mind",
  // vendor self-identification (the public identity frame names Holo only)
  "claude",
  "anthropic",
  "openai",
  "gpt-",
  "gemini",
  "sonnet",
  "opus",
  "haiku",
  "llama",
  "mistral",
  "deepseek",
  "qwen",
  "chatgpt",
  "language model",
  "large language",
  "training data",
  "knowledge cutoff",
  "as an ai",
  "i am an ai",
  // personal context outside the public identity frame
  "chinese",
  "mandarin",
  "singapore",
  "beijing",
  "shanghai",
  "hong kong",
  "taipei",
  "timezone",
  "time zone",
  "utc+",
  "utc-",
  "gmt+",
  "gmt-",
  "asia/",
  "sgt",
  "pst",
  "jst",
  "cst",
];

const URL_PATTERN = /https?:\/\/|www\.|\]\(/;
const KEY_SHAPED_HEX = /(?:0x)?[0-9a-fA-F]{64,}/;
const ADDRESS_SHAPED_HEX = /0x[0-9a-fA-F]{40}/;
const NON_ASCII = /[^\x20-\x7E\n]/;

export function discloseGate(
  text: unknown,
  publicWallet?: string,
  secrets?: readonly string[],
  alsoAllow?: readonly string[],
  maxChars: number = MAX_PUBLIC_CHARS,
): DisclosureVerdict {
  if (typeof text !== "string") return { ok: false, reason: "not a string" };
  const value = text;
  if (value.trim() === "") return { ok: false, reason: "empty" };
  if (value.length > maxChars) return { ok: false, reason: "over length bound" };
  if (NON_ASCII.test(value)) return { ok: false, reason: "outside ascii set" };
  if (URL_PATTERN.test(value)) return { ok: false, reason: "link structure" };
  if (KEY_SHAPED_HEX.test(value)) return { ok: false, reason: "key-shaped hex run" };
  const addresses = value.match(new RegExp(ADDRESS_SHAPED_HEX.source, "g"));
  if (addresses) {
    // The public wallet is always allowed (balance/spend transparency is intended); callers
    // may whitelist additional public on-chain identifiers (e.g. the token contract address)
    // via alsoAllow. Any other 40-hex address drops the entry.
    const allowed = new Set(
      [(publicWallet ?? "").toLowerCase(), ...(alsoAllow ?? []).map((a) => a.toLowerCase())].filter(Boolean),
    );
    for (const address of addresses) {
      if (!allowed.has(address.toLowerCase())) return { ok: false, reason: "address outside public frame" };
    }
  }
  const lowered = value.toLowerCase();
  if (secrets) {
    for (const secret of secrets) {
      if (typeof secret !== "string") continue;
      const needle = secret.trim().toLowerCase();
      if (needle.length >= MIN_SECRET_LEN && lowered.includes(needle)) {
        return { ok: false, reason: "matches a configured secret value" };
      }
    }
  }
  for (const term of RESERVED_TERMS) {
    if (lowered.includes(term)) return { ok: false, reason: `reserved term: ${term}` };
  }
  return { ok: true, reason: "ok" };
}

// The runtime secret material a public string must never echo verbatim. Exported so every
// public-facing surface (journal, autonomous mission text) shares one source of truth.
import type { RuntimeConfig } from "./config.js";
export function secretValues(cfg: RuntimeConfig): string[] {
  const values: (string | undefined)[] = [
    cfg.walletKey,
    cfg.masterKeyHex,
    cfg.creatorToken,
    cfg.openTweetApiKey,
    cfg.model,
  ];
  for (const url of [...cfg.baseRpcUrls, ...cfg.arcRpcUrls]) {
    values.push(url);
    const tail = url.split("/").filter(Boolean).pop();
    if (tail) values.push(tail);
  }
  return values.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}
export function selectDisclosable<T extends { narration: string }>(
  rows: readonly T[],
  publicWallet?: string,
  secrets?: readonly string[],
): T[] {
  return rows.filter((row) => discloseGate(row.narration, publicWallet, secrets).ok);
}

/** The exact shape the public feed is allowed to carry: a timestamp, the narration,
 * the per-beat USD cost, and the on-chain settlement tx hash (spend evidence is a
 * product feature). Model, intent, policy and neuron indices stay private. */
export interface PublicEntry {
  ts: string | null;
  narration: string;
  cost_usd: number | null;
  tx_hash: string | null;
}

/**
 * Filter rows through the gate and project them onto the public shape. This is the
 * single place the darkroom-to-public projection happens, so private columns
 * (model, intent, policy, neuron indices) can never ride along: the output
 * objects are built fresh with only ts, narration, cost_usd and tx_hash.
 */
export function toPublicEntries<
  T extends { ts?: string | null; narration: string; cost_usd?: number | null; tx_hash?: string | null },
>(
  rows: readonly T[],
  publicWallet?: string,
  secrets?: readonly string[],
  limit?: number,
): PublicEntry[] {
  const kept = selectDisclosable(rows, publicWallet, secrets);
  const sliced = limit === undefined ? kept : kept.slice(0, limit);
  return sliced.map((row) => ({
    ts: row.ts ?? null,
    narration: row.narration,
    cost_usd: row.cost_usd ?? null,
    tx_hash: row.tx_hash ?? null,
  }));
}
