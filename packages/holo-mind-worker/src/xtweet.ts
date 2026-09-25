// X (Twitter) self-broadcast rail — Holo posts to its own account via OpenTweet.
//
// ISOLATION (the user's hard requirement: never leak the wallet key). This module is the
// "speaking" path. It is NEVER given cfg.walletKey and cannot sign or spend anything; the
// only credential it holds is the OpenTweet ot_ key, which posts text and nothing else. The
// signing path (pay.ts / x402buy.ts) and this speaking path share no key material.
//
// FAIL-CLOSED OUTBOUND GATE. Nothing is posted until it passes every check below; anything
// that trips a check is recorded status='dropped' and NOT sent (we never redact-and-send, so
// a partial leak is not representable):
//   1. disarmed     — broadcast disabled or no OpenTweet key => nothing posts (inert).
//   2. caps         — a global per-day ceiling across every kind of post (the plan gives them
//                     one shared bucket), a lower per-day ceiling on self-posts so an event
//                     broadcast always has room, a per-day reply ceiling, and a minimum-gap
//                     backstop on the rhythm. All counted from SENT rows in the log.
//   3. no-repeat    — dedup hash of the text must not match a recent sent post, and word
//                     overlap against recent posts must stay under the similarity ceiling.
//   4. content gate — the MODEL-GENERATED PROSE passes discloseGate (secrets / 64-hex key
//                     shape / addresses outside the public frame / links / non-ascii /
//                     reserved terms) PLUS an identity check (first-person Holo; it may not
//                     deny being Holo or claim to be another product).
//   5. token gate   — model-authored prose may not carry a cashtag, a trading pair, or the
//                     name/ticker of any token but its own.
//   6. final scan   — the composed text (prose + trusted suffix) is re-scanned for literal
//                     secret values and the configured character bound before it leaves.
//
// The tx hash / links / amounts in event broadcasts are NOT model output: the caller builds
// them as a `suffix` from trusted constants and verified DB/chain data and they are appended
// AFTER the prose is gated. So the model can never inject an arbitrary link or a key-shaped
// hex run into a post — the gate rejects those in prose, and the suffix is code-controlled.

import { discloseGate, secretValues } from "./disclose.js";
import type { RuntimeConfig } from "./config.js";

export type XPostKind = "post" | "reply";

// Build the broadcast config from the runtime config. The OpenTweet key is the ONLY credential
// carried over — the wallet key is deliberately never referenced here (speaking path != signing
// path). secretValues(cfg) already includes the ot_ key, so the key itself can never be echoed.
export function broadcastConfig(cfg: RuntimeConfig, baseUrl = cfg.openTweetBaseUrl): XBroadcastConfig {
  return {
    apiKey: cfg.openTweetApiKey,
    enabled: cfg.xBroadcastEnabled,
    baseUrl,
    // The catch-up gap is deliberately shorter than the normal random gap, so the backstop here
    // takes the smaller of the two: it exists to stop a caller from rapid-firing, not to enforce
    // the rhythm (the rhythm lives in the schedule table).
    minGapMinutes: Math.max(1, Math.min(cfg.xGapMinMinutes, cfg.xBehindGapMinutes)),
    postMaxPerDay: cfg.xPostMaxPerDay,
    globalMaxPerDay: cfg.xGlobalMaxPerDay,
    replyMaxPerDay: cfg.xReplyMaxPerDay,
    maxChars: cfg.xPostMaxChars,
    publicWallet: cfg.publicWallet,
    tokenCa: cfg.tokenCa,
    secrets: secretValues(cfg),
    signature: "- Holo",
    similarityThreshold: 0.6,
  };
}

export interface XBroadcastConfig {
  apiKey?: string; // OpenTweet ot_ key; absent => disarmed
  enabled: boolean; // broadcast kill switch
  baseUrl: string; // OpenTweet base url
  minGapMinutes: number; // hard floor between two self-posts; the random gap is drawn above it
  postMaxPerDay: number; // ceiling on self-posts per UTC day
  globalMaxPerDay: number; // ceiling on ALL kinds per UTC day (the plan's single bucket)
  replyMaxPerDay: number;
  maxChars: number; // X character bound for the composed text (configurable; the account is verified, so long-form is allowed)
  publicWallet: string; // allowed address in prose
  tokenCa: string; // additional allowed public address (token contract)
  secrets: readonly string[]; // literal secret values that must never appear (incl. the ot_ key)
  signature: string; // code-appended sign-off on every post ("" disables); guarantees attribution
  similarityThreshold: number; // near-duplicate word-overlap (Jaccard) ceiling; >= this is dropped
}

// The subset of the D1 store this rail needs. Injected so the gate is testable without D1.
export interface XPostStore {
  countXSentSince(dayPrefix: string, kind: XPostKind): Promise<number>;
  countXSentAllToday(dayPrefix: string): Promise<number>;
  countXSelfSentToday(dayPrefix: string): Promise<number>;
  lastXSentAt(kind: XPostKind): Promise<string | null>;
  recentXHashes(n: number): Promise<string[]>;
  recentXTexts(n: number): Promise<string[]>;
  recordXPost(row: {
    kind: XPostKind;
    text: string;
    dedupHash: string;
    ref?: string | null;
    trigger?: string | null;
    status?: "sent" | "dropped" | "failed";
    gateReason?: string | null;
    opentweetId?: string | null;
    inReplyTo?: string | null;
    postedAt?: string;
    corpusId?: number | null;
    angle?: string | null;
  }): Promise<number>;
}

export interface XTweetDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollAttempts?: number; // how many times to poll GET /posts/:id for the async publish result
  pollDelayMs?: number; // delay between publish-status polls
}

export interface PostResult {
  posted: boolean;
  status: "sent" | "dropped" | "failed";
  reason: string;
  id?: string | null;
  url?: string | null;
  rowId?: number;
}

// Phrases that would mean the text is NOT speaking as Holo. discloseGate already blocks
// vendor self-identification ("claude", "as an ai", "language model", ...); these catch an
// attempt to disown the Holo identity specifically. Best-effort denylist — the structural
// guarantee is that prose carrying any of these is dropped, not posted.
const IDENTITY_DENIAL: readonly string[] = [
  "i am not holo",
  "i'm not holo",
  "i am not an autonomous",
  "my name is not holo",
  "i am not the fly",
  "this is not holo",
  "i am someone else",
  "i am a different",
  "pretend to be",
  "roleplay as",
];

const dayPrefix = (d: Date) => d.toISOString().slice(0, 10);

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export async function dedupHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeForDedup(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Content words (length > 2) as a set, for near-duplicate detection. The exact-hash dedup
// only catches identical text; this catches "same idea, reworded" so Holo does not keep
// saying the same thing in different words.
function contentWords(text: string): Set<string> {
  return new Set(normalizeForDedup(text).split(" ").filter((w) => w.length > 2));
}

// Jaccard overlap of content words between two texts: 0 = disjoint, 1 = identical sets.
export function wordOverlap(a: string, b: string): number {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// Strip the code-appended signature so similarity compares the actual message body.
function stripSignature(text: string, signature: string): string {
  if (!signature) return text;
  return text.endsWith(signature) ? text.slice(0, text.length - signature.length).trim() : text.trim();
}

// Pure content gate on the model-generated PROSE only (no links / no hashes expected here).
export function contentGate(prose: string, cfg: XBroadcastConfig): { ok: boolean; reason: string } {
  // The prose is bounded by this rail's own character cap, not the heartbeat's public-narration
  // bound: a verified account may post long-form, so the two limits are deliberately decoupled.
  const verdict = discloseGate(prose, cfg.publicWallet, cfg.secrets, [cfg.tokenCa], cfg.maxChars);
  if (!verdict.ok) return verdict;
  const lowered = prose.toLowerCase();
  for (const phrase of IDENTITY_DENIAL) {
    if (lowered.includes(phrase)) return { ok: false, reason: `identity check: ${phrase}` };
  }
  return { ok: true, reason: "ok" };
}

// Full token names, matched case-insensitively on word boundaries. Words that are also ordinary
// English (optimism, polygon, render, jupiter, near, ton, apt, link, meme) are deliberately NOT
// here: banning them would silently drop legitimate prose far more often than it would catch a
// token reference. Those are still caught by the cashtag rule below.
const TOKEN_NAMES: readonly string[] = [
  "bitcoin", "ethereum", "solana", "dogecoin", "shiba inu", "cardano", "ripple", "avalanche",
  "polkadot", "chainlink", "tether", "usdc", "usdt", "usd coin", "uniswap", "litecoin", "tron",
  "binance coin", "pepe", "bonk", "floki", "worldcoin", "arbitrum", "aptos", "celestia",
  "bittensor", "dogwifhat",
];

// Tickers, matched case-SENSITIVELY: an all-caps run is how a ticker is actually written, and
// requiring case keeps lowercase English words out of the net.
const TOKEN_TICKERS: readonly string[] = [
  "BTC", "ETH", "SOL", "DOGE", "SHIB", "BNB", "XRP", "ADA", "AVAX", "MATIC", "LINK", "TON",
  "TRX", "DOT", "USDT", "USDC", "WIF", "BONK", "FLOKI", "LTC", "UNI", "AAVE", "SUI", "APT",
  "ARB", "OP", "NEAR", "INJ", "TIA", "SEI", "JUP", "PYTH", "WLD", "RNDR", "FET", "TAO",
  "BRETT", "MOG", "SPX", "GIGA", "PEPE",
];

// Token discipline: Holo may speak about its own token (its CA is whitelisted in the address
// gate) and about nothing else's. Two shapes are caught — a cashtag and a known name/ticker.
// HONEST LIMIT: a token can be described without ever being named ("that dog coin"), and no
// denylist closes that. What is guaranteed is narrower and real: no other token's address can
// appear (the address gate rejects any 40-hex outside the public frame), no cashtag can appear,
// and no name on this list can appear.
export function tokenGate(prose: string): { ok: boolean; reason: string } {
  const cashtag = prose.match(/\$\s*[A-Za-z]{2,10}\b/);
  if (cashtag) return { ok: false, reason: `cashtag ${cashtag[0].trim()}` };
  const pair = prose.match(/\b[A-Z]{2,10}\/USD[T]?\b/);
  if (pair) return { ok: false, reason: `trading pair ${pair[0]}` };
  const lowered = prose.toLowerCase();
  for (const name of TOKEN_NAMES) {
    if (new RegExp(`\\b${name.replace(/ /g, "\\s+")}\\b`, "i").test(lowered)) {
      return { ok: false, reason: `names another token (${name})` };
    }
  }
  for (const t of TOKEN_TICKERS) {
    if (new RegExp(`(^|[^A-Za-z0-9])${t}([^A-Za-z0-9]|$)`).test(prose)) {
      return { ok: false, reason: `names another token (${t})` };
    }
  }
  return { ok: true, reason: "ok" };
}

// Compose the final tweet: gated prose + a code-controlled trusted suffix (tx hash / links /
// amounts). The suffix is appended AFTER gating and is then re-scanned for literal secrets and
// the character bound, so a trusted-looking suffix can still never carry a key out.
export function composeTweet(prose: string, suffix?: string): string {
  const p = prose.trim();
  const s = (suffix ?? "").trim();
  return s ? `${p}\n\n${s}` : p;
}

function finalScan(text: string, cfg: XBroadcastConfig): { ok: boolean; reason: string } {
  if (text.length > cfg.maxChars) return { ok: false, reason: `over ${cfg.maxChars} chars` };
  const lowered = text.toLowerCase();
  for (const secret of cfg.secrets) {
    const needle = (secret ?? "").trim().toLowerCase();
    if (needle.length >= 8 && lowered.includes(needle)) return { ok: false, reason: "matches a configured secret value" };
  }
  return { ok: true, reason: "ok" };
}

interface OpenTweetXResult {
  platform?: string;
  status?: string;
  post_id?: string;
  url?: string;
}
interface OpenTweetPost {
  id?: string;
  posted?: boolean;
  failed?: boolean;
  status?: string;
  x_post_id?: string;
  url?: string;
  results?: OpenTweetXResult[];
}
interface OpenTweetResponse extends OpenTweetPost {
  success?: boolean;
  posts?: OpenTweetPost[];
  post?: OpenTweetPost;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Read the publish state from any level of an OpenTweet response (top level, posts[0], or a
// single-post GET). OpenTweet attaches x_post_id/posted/results once the async X publish
// lands, so a 201 create response may not carry them yet — hence the poll in postTweet.
function publishState(o?: OpenTweetPost | null): { published: boolean; failed: boolean; id: string | null; url: string | null } {
  if (!o) return { published: false, failed: false, id: null, url: null };
  const xr = (o.results ?? []).find((r) => r.platform === "x");
  const published = o.posted === true || !!o.x_post_id || o.status === "posted" || xr?.status === "published";
  const failed = o.failed === true || o.status === "failed" || xr?.status === "failed";
  const id = o.x_post_id ?? xr?.post_id ?? o.id ?? null;
  const url = xr?.url ?? o.url ?? null;
  return { published, failed, id, url };
}

// Post one tweet to X via OpenTweet. `prose` is model-generated and gated; `suffix` is
// code-built trusted text (links/hashes/amounts) appended after gating. Phase 1 posts only
// (kind='post'); replies are a later phase pending the inbound-mention read path.
export async function postTweet(
  cfg: XBroadcastConfig,
  store: XPostStore,
  opts: {
    prose: string;
    suffix?: string;
    trigger?: string;
    ref?: string | null;
    kind?: XPostKind;
    corpusId?: number | null;
    angle?: string | null;
  },
  deps: XTweetDeps = {},
): Promise<PostResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const kind: XPostKind = opts.kind ?? "post";
  // body = gated prose + trusted suffix; the signature is appended by code so attribution is
  // guaranteed regardless of what the model wrote. Dedup/similarity compare the body only.
  const body = composeTweet(opts.prose, opts.suffix);
  const text = cfg.signature ? `${body}\n\n${cfg.signature}` : body;
  const hash = await dedupHash(body);
  const nowDate = now();

  const drop = async (reason: string, status: "dropped" | "failed" = "dropped"): Promise<PostResult> => {
    const rowId = await store.recordXPost({
      kind,
      text,
      dedupHash: hash,
      ref: opts.ref ?? null,
      trigger: opts.trigger ?? null,
      status,
      gateReason: reason,
      postedAt: nowDate.toISOString(),
      corpusId: opts.corpusId ?? null,
      angle: opts.angle ?? null,
    });
    return { posted: false, status, reason, rowId };
  };

  // 1. disarmed — inert without an explicit enable AND a key.
  if (!cfg.enabled) return drop("broadcast disabled");
  if (!cfg.apiKey) return drop("no OpenTweet key (disarmed)");

  // 2. Caps, counted from SENT rows in the log (never from a cached counter, which can drift).
  //    The plan gives every kind of post one shared bucket, so the global ceiling is checked
  //    first; self-posts get a lower ceiling of their own so an event broadcast always has room.
  const today = dayPrefix(nowDate);
  const sentAll = await store.countXSentAllToday(today);
  if (sentAll >= cfg.globalMaxPerDay) return drop(`daily plan cap reached (${sentAll}/${cfg.globalMaxPerDay})`);
  if (kind === "post") {
    // Backstop on the rhythm. The schedule table decides when a self-post is due; this only
    // stops a caller (or a bug in the schedule) from firing twice inside the minimum gap.
    const last = await store.lastXSentAt("post");
    if (last) {
      const elapsedMin = (nowDate.getTime() - new Date(last).getTime()) / 60_000;
      if (elapsedMin < cfg.minGapMinutes) return drop(`gap: ${elapsedMin.toFixed(0)}min < ${cfg.minGapMinutes}min`);
    }
    if (opts.trigger === "cadence") {
      const selfToday = await store.countXSelfSentToday(today);
      if (selfToday >= cfg.postMaxPerDay) return drop(`daily self-post cap reached (${selfToday})`);
    }
  } else {
    const repliesToday = await store.countXSentSince(today, "reply");
    if (repliesToday >= cfg.replyMaxPerDay) return drop(`daily reply cap reached (${repliesToday})`);
  }

  // 3. no-repeat: exact-duplicate hash, then near-duplicate word overlap against recent posts
  //    (the signature is stripped so it does not inflate similarity). This is what enforces
  //    "do not keep saying the same thing in different words".
  const recent = await store.recentXHashes(40);
  if (recent.includes(hash)) return drop("duplicate of a recent post");
  const recentTexts = await store.recentXTexts(40);
  for (const prev of recentTexts) {
    const overlap = wordOverlap(body, stripSignature(prev, cfg.signature));
    if (overlap >= cfg.similarityThreshold) {
      return drop(`too similar to a recent post (overlap ${overlap.toFixed(2)})`);
    }
  }

  // 4. content gate on the model prose.
  const gated = contentGate(opts.prose, cfg);
  if (!gated.ok) return drop(`content gate: ${gated.reason}`);

  // 5. token discipline on model-authored prose: Holo speaks about itself, never about someone
  //    else's token. The address layer already rejects any 40-hex outside the public frame; this
  //    covers the two ways a token shows up without an address — a cashtag and a well-known name.
  //    Applied to cadence posts (the model's own words) and not to the event templates, whose
  //    text is code-composed from verified mission data.
  if (opts.trigger === "cadence") {
    const tokened = tokenGate(opts.prose);
    if (!tokened.ok) return drop(`token gate: ${tokened.reason}`);
  }

  // 6. final scan on the composed text.
  const scanned = finalScan(text, cfg);
  if (!scanned.ok) return drop(`final scan: ${scanned.reason}`);

  // Send to OpenTweet, pinned to X only (an omitted platforms field would follow the
  // account's auto-cross-post setting and could leak to Bluesky/LinkedIn).
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/api/v1/posts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, publish_now: true, platforms: ["x"] }),
    });
  } catch (e) {
    return drop(`opentweet request failed: ${(e as Error).message}`, "failed");
  }

  // A non-2xx means OpenTweet did not publish (e.g. 502 = saved but not published).
  if (res.status !== 200 && res.status !== 201) {
    return drop(`opentweet http ${res.status}`, "failed");
  }

  let otResp: OpenTweetResponse = {};
  try {
    otResp = (await res.json()) as OpenTweetResponse;
  } catch {
    otResp = {};
  }

  // Publish confirmation may sit at the top level or inside posts[0]; check both.
  const top = publishState(otResp);
  const first = publishState(otResp.posts?.[0]);
  let published = top.published || first.published;
  let failed = top.failed || first.failed;
  let id = top.id ?? first.id ?? otResp.posts?.[0]?.id ?? otResp.id ?? null;
  let url = top.url ?? first.url ?? null;

  // OpenTweet publishes asynchronously: a 201 can arrive before the X result is attached.
  // Poll the post by id until it reports published/failed (bounded), so a real success is
  // never mis-recorded as a failure — a 'failed' row would let the cadence gate fire a
  // duplicate post on the next tick.
  const postId = otResp.posts?.[0]?.id ?? otResp.id ?? null;
  if (!published && !failed && postId) {
    const attempts = deps.pollAttempts ?? 4;
    const delay = deps.pollDelayMs ?? 700;
    const sleep = deps.sleep ?? defaultSleep;
    const base = cfg.baseUrl.replace(/\/$/, "");
    for (let i = 0; i < attempts && !published && !failed; i++) {
      await sleep(delay);
      try {
        const g = await fetchImpl(`${base}/api/v1/posts/${postId}`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
        });
        const gj = (await g.json()) as OpenTweetResponse;
        const st = publishState(gj.post ?? gj);
        if (st.published) {
          published = true;
          id = st.id ?? id;
          url = st.url ?? url;
        } else if (st.failed) {
          failed = true;
        }
      } catch {
        // ignore a transient poll error and try again
      }
    }
  }

  if (failed) return drop("opentweet reported publish failed", "failed");

  if (!published) {
    // 201 accepted + publish_now requested, but the publish result never confirmed within the
    // poll window. Record as SENT so it occupies the cadence/dedup slot: OpenTweet has the post
    // and will publish it, and a duplicate public post is worse than an optimistic record.
    const rowId = await store.recordXPost({
      kind,
      text,
      dedupHash: hash,
      ref: opts.ref ?? null,
      trigger: opts.trigger ?? null,
      status: "sent",
      gateReason: "publish unconfirmed after poll; recorded sent to prevent a duplicate",
      opentweetId: id,
      postedAt: nowDate.toISOString(),
      corpusId: opts.corpusId ?? null,
      angle: opts.angle ?? null,
    });
    return { posted: true, status: "sent", reason: "publish unconfirmed (recorded sent)", id, url, rowId };
  }

  const rowId = await store.recordXPost({
    kind,
    text,
    dedupHash: hash,
    ref: opts.ref ?? null,
    trigger: opts.trigger ?? null,
    status: "sent",
    opentweetId: id,
    postedAt: nowDate.toISOString(),
    corpusId: opts.corpusId ?? null,
    angle: opts.angle ?? null,
  });
  return { posted: true, status: "sent", reason: "ok", id, url, rowId };
}
