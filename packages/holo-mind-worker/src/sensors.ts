// Best-effort "world digest": real recent changes in the project, read from the
// public GitHub repositories. The prompt fences this as untrusted reference data
// (see prompt.ts), and it is cached so a beat never hammers the API. Any failure
// yields null and the section is simply omitted — an optional sensor must never
// break, block, or slow down a heartbeat.

const REPOS = ["ArcHolotype/holotype-mind", "ArcHolotype/holotype-web"] as const;
const CACHE_KEY = "https://holotype.internal/world-digest";
const CACHE_TTL_SECONDS = 1800; // 30 min: commits are infrequent; also avoids API rate limits
const PER_REPO = 2;

// Pure: turn a GitHub commits payload into compact `- repo: "subject" (date)` lines.
// Kept separate from the network call so it is unit-testable without mocking fetch.
export function formatCommitLines(repo: string, commits: unknown): string[] {
  const name = repo.split("/")[1] ?? repo;
  if (!Array.isArray(commits)) return [];
  const out: string[] = [];
  for (const c of commits.slice(0, PER_REPO)) {
    const commit = (c as { commit?: { message?: unknown; author?: { date?: unknown } } })?.commit;
    const subject = String(commit?.message ?? "").split("\n")[0].trim().slice(0, 80);
    const date = String(commit?.author?.date ?? "").slice(0, 10);
    if (subject) out.push(`- ${name}: "${subject}"${date ? ` (${date})` : ""}`);
  }
  return out;
}

// Fetch (or read from cache) a short digest of the latest commits across the public
// repos. Returns null when nothing could be read; the caller treats null as "no world
// section this beat".
export async function readWorldDigest(): Promise<string | null> {
  try {
    const cache = caches.default;
    const key = new Request(CACHE_KEY);
    const hit = await cache.match(key);
    if (hit) {
      const text = (await hit.text()).trim();
      return text || null;
    }
    const lines: string[] = [];
    for (const repo of REPOS) {
      const res = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=${PER_REPO}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "holotype-mind" },
      });
      if (!res.ok) continue;
      lines.push(...formatCommitLines(repo, await res.json()));
    }
    if (!lines.length) return null;
    const digest = lines.join("\n");
    await cache.put(
      key,
      new Response(digest, { headers: { "cache-control": `max-age=${CACHE_TTL_SECONDS}` } }),
    );
    return digest;
  } catch {
    return null;
  }
}
