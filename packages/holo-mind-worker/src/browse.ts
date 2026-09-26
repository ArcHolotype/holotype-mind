// Autonomous browsing (read-only). Each beat Holo may name things it is curious about in
// `intent.curiosity` (full URLs, or topics looked up on Wikipedia). On the NEXT beat we fetch
// a small, hard-bounded, text-only digest of those and fence it into the prompt as untrusted
// data (see prompt.ts). This is the same best-effort contract as sensors.ts: EVERY cap is a
// wall (item count, per-item chars, per-request timeout, and one total wall-clock deadline),
// and any failure, timeout, or empty result yields null so the section is simply omitted.
// Browsing runs off the critical path of the model call and can NEVER block, slow, or break a
// heartbeat or the broadcast rail — the beat proceeds with whatever digest (if any) came back.

export interface BrowseCaps {
  maxItems: number; // how many curiosity entries we will fetch this beat
  totalTimeoutMs: number; // wall-clock ceiling for the WHOLE browse step
  maxCharsPerItem: number; // text kept per fetched item
}

export const DEFAULT_BROWSE_CAPS: BrowseCaps = {
  maxItems: 3,
  totalTimeoutMs: 8000,
  maxCharsPerItem: 1200,
};

const PER_REQUEST_TIMEOUT_MS = 4000; // one fetch never eats the whole budget by itself

// Pull the curiosity list out of the previous beat's persisted intent JSON. Tolerant: a
// missing/malformed field just means "nothing requested". Entries are trimmed, de-duped,
// length-capped strings; non-strings and empties are dropped. Pure + unit-testable.
export function parseCuriosity(intentJson: string | null | undefined, maxItems: number): string[] {
  if (!intentJson || maxItems <= 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(intentJson);
  } catch {
    return [];
  }
  const raw = (parsed as { curiosity?: unknown })?.curiosity;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const s = item.trim().replace(/\s+/g, " ").slice(0, 300);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

// Crude HTML -> readable text. Workers have no DOM, so this is a deliberate, minimal strip:
// drop script/style/svg, remove tags, decode the handful of entities that matter, collapse
// whitespace, and cut to maxChars. Good enough for "reading material", never for rendering.
export function htmlToText(html: string, maxChars: number): string {
  const noBlocks = String(html ?? "")
    .replace(/<\s*(script|style|svg|noscript|head)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = noBlocks
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, Math.max(0, maxChars));
}

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim());

// Fetch with a hard timeout that also respects the shared deadline. Returns null on any
// error, timeout, or non-OK status — never throws.
async function getWithDeadline(
  url: string,
  deadline: number,
  accept: string,
): Promise<Response | null> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(PER_REQUEST_TIMEOUT_MS, remaining));
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept, "user-agent": "holotype-mind (autonomous reader)" },
      redirect: "follow",
    });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Read one named URL. Text-ish pages only; anything binary/JSON is best-effort stringified.
async function readUrl(target: string, deadline: number, maxChars: number): Promise<string | null> {
  const res = await getWithDeadline(target, deadline, "text/html,application/json;q=0.9,*/*;q=0.5");
  if (!res) return null;
  const body = await res.text().catch(() => "");
  if (!body) return null;
  const text = htmlToText(body, maxChars);
  return text || null;
}

// Look a free-text topic up on Wikipedia: one search request for the best title, then the REST
// summary for a clean extract. Two bounded requests; either failing yields null.
async function readTopic(topic: string, deadline: number, maxChars: number): Promise<string | null> {
  const q = encodeURIComponent(topic);
  const searchUrl =
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}` +
    `&srlimit=1&format=json&formatversion=2`;
  const searchRes = await getWithDeadline(searchUrl, deadline, "application/json");
  if (!searchRes) return null;
  const title: string | null = await searchRes
    .json()
    .then((j: any) => (j?.query?.search?.[0]?.title as string) ?? null)
    .catch(() => null);
  if (!title) return null;
  const sumRes = await getWithDeadline(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    deadline,
    "application/json",
  );
  if (!sumRes) return null;
  const extract: string | null = await sumRes
    .json()
    .then((j: any) => (typeof j?.extract === "string" ? j.extract : null))
    .catch(() => null);
  if (!extract) return null;
  return `[wikipedia: ${title}] ${extract.trim().slice(0, Math.max(0, maxChars))}`;
}

// Fetch a bounded digest for the beat's curiosity list. Returns null when nothing was
// requested or nothing could be read, so the caller omits the section. Never throws.
export async function readBrowseDigest(
  curiosity: string[],
  caps: BrowseCaps = DEFAULT_BROWSE_CAPS,
): Promise<string | null> {
  const targets = (curiosity ?? []).slice(0, Math.max(0, caps.maxItems));
  if (!targets.length) return null;
  const deadline = Date.now() + caps.totalTimeoutMs;
  const blocks: string[] = [];
  for (const target of targets) {
    if (Date.now() >= deadline) break; // global wall — stop cleanly, keep what we have
    try {
      const text = isUrl(target)
        ? await readUrl(target, deadline, caps.maxCharsPerItem)
        : await readTopic(target, deadline, caps.maxCharsPerItem);
      if (text) blocks.push(`- ${isUrl(target) ? target : `topic "${target}"`}:\n  ${text}`);
    } catch {
      // one bad target never sinks the rest
    }
  }
  return blocks.length ? blocks.join("\n") : null;
}
