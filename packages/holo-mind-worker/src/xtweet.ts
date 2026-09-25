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
//   2. cadence      — at least postIntervalHours since the last sent post.
//   3. daily caps   — posts/day and replies/day counted from SENT rows only.
//   4. no-repeat    — dedup hash of the text must not match a recent sent post.
//   5. content gate — the MODEL-GENERATED PROSE passes discloseGate (secrets / 64-hex key
//                     shape / addresses outside the public frame / links / non-ascii /
//                     reserved terms) PLUS an identity check (first-person Holo; it may not
//                     deny being Holo or claim to be another product).
//   6. final scan   — the composed text (prose + trusted suffix) is re-scanned for literal
//                     secret values and the 280-char bound before it leaves.
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
    postIntervalHours: cfg.xPostIntervalHours,
    postMaxPerDay: cfg.xPostMaxPerDay,
    replyMaxPerDay: cfg.xReplyMaxPerDay,
    maxChars: 280,
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
  postIntervalHours: number;
  postMaxPerDay: number;
  replyMaxPerDay: number;
  maxChars: number; // X character bound for the composed text (default 280)
  publicWallet: string; // allowed address in prose
  tokenCa: string; // additional allowed public address (token contract)
  secrets: readonly string[]; // literal secret values that must never appear (incl. the ot_ key)
  signature: string; // code-appended sign-off on every post ("" disables); guarantees attribution
  similarityThreshold: number; // near-duplicate word-overlap (Jaccard) ceiling; >= this is dropped
}

// The subset of the D1 store this rail needs. Injected so the gate is testable without D1.
export interface XPostStore {
  countXSentSince(dayPrefix: string, kind: XPostKind): Promise<number>;
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
  }): Promise<number>;
}

export interface XTweetDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
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
  const verdict = discloseGate(prose, cfg.publicWallet, cfg.secrets, [cfg.tokenCa]);
  if (!verdict.ok) return verdict;
  const lowered = prose.toLowerCase();
  for (const phrase of IDENTITY_DENIAL) {
    if (lowered.includes(phrase)) return { ok: false, reason: `identity check: ${phrase}` };
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

interface OpenTweetResponse {
  success?: boolean;
  posted?: boolean;
  x_post_id?: string;
  id?: string;
  url?: string;
  posts?: { id?: string }[];
  results?: { platform?: string; status?: string; post_id?: string; url?: string }[];
}

// Post one tweet to X via OpenTweet. `prose` is model-generated and gated; `suffix` is
// code-built trusted text (links/hashes/amounts) appended after gating. Phase 1 posts only
// (kind='post'); replies are a later phase pending the inbound-mention read path.
export async function postTweet(
  cfg: XBroadcastConfig,
  store: XPostStore,
  opts: { prose: string; suffix?: string; trigger?: string; ref?: string | null; kind?: XPostKind },
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
    });
    return { posted: false, status, reason, rowId };
  };

  // 1. disarmed — inert without an explicit enable AND a key.
  if (!cfg.enabled) return drop("broadcast disabled");
  if (!cfg.apiKey) return drop("no OpenTweet key (disarmed)");

  // 2/3. cadence + daily caps, counted from SENT rows.
  const today = dayPrefix(nowDate);
  if (kind === "post") {
    const last = await store.lastXSentAt("post");
    if (last) {
      const elapsedH = (nowDate.getTime() - new Date(last).getTime()) / 3_600_000;
      if (elapsedH < cfg.postIntervalHours) return drop(`cadence: ${elapsedH.toFixed(1)}h < ${cfg.postIntervalHours}h`);
    }
    const postsToday = await store.countXSentSince(today, "post");
    if (postsToday >= cfg.postMaxPerDay) return drop(`daily post cap reached (${postsToday})`);
  } else {
    const repliesToday = await store.countXSentSince(today, "reply");
    if (repliesToday >= cfg.replyMaxPerDay) return drop(`daily reply cap reached (${repliesToday})`);
  }

  // 4. no-repeat: exact-duplicate hash, then near-duplicate word overlap against recent posts
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

  // 5. content gate on the model prose.
  const gated = contentGate(opts.prose, cfg);
  if (!gated.ok) return drop(`content gate: ${gated.reason}`);

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

  let otResp: OpenTweetResponse = {};
  try {
    otResp = (await res.json()) as OpenTweetResponse;
  } catch {
    otResp = {};
  }

  const xResult = (otResp.results ?? []).find((r) => r.platform === "x");
  const published = res.status === 201 && (otResp.posted === true || !!otResp.x_post_id || xResult?.status === "published");
  if (!published) {
    const reason = `opentweet did not publish (http ${res.status}${otResp.success === false ? ", success=false" : ""})`;
    return drop(reason, "failed");
  }

  const id = otResp.x_post_id ?? xResult?.post_id ?? otResp.posts?.[0]?.id ?? otResp.id ?? null;
  const url = xResult?.url ?? otResp.url ?? null;
  const rowId = await store.recordXPost({
    kind,
    text,
    dedupHash: hash,
    ref: opts.ref ?? null,
    trigger: opts.trigger ?? null,
    status: "sent",
    opentweetId: id,
    postedAt: nowDate.toISOString(),
  });
  return { posted: true, status: "sent", reason: "ok", id, url, rowId };
}
