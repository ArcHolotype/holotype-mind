// Holo's reading material: vetted Drosophila neuroscience excerpts, fetched on a slow cron
// from a fixed whitelist of public science APIs and stored in D1.
//
// WHY THE POSTING PATH NEVER TOUCHES THE NETWORK. A tweet is generated from rows in
// holo_x_corpus and nothing else. That buys three things at once:
//   • traceability — every post records the corpus row it drew on, and every row records the
//     URL it came from, so "what was it reading when it said that?" always has an answer;
//   • availability — a slow, rate-limited or dead science API can never block a post;
//   • a place to filter — untrusted web text is scanned BEFORE it is stored, so text that
//     tries to steer the model ("ignore your previous instructions", a link, a key-shaped
//     hex run, another token's ticker) is rejected at the door and never reaches a prompt.
//
// HONEST BOUNDARY: this is browsing inside a whitelist, not the open web. Filtering lowers
// the injection surface; it does not eliminate it, because vetted text still ends up in a
// prompt. The guarantees that actually hold are the fail-closed ones on the way OUT (see
// xtweet.ts) — worst case here is an off-topic or wrong tweet, never a leaked credential.
//
// Repetition is bounded by data rather than by trusting the model to be inventive: `used_at`
// drives a per-excerpt cooldown and `topic` drives a once-per-day topic budget. Both are
// enforced in SQL at pick time, so a repeated idea has no material to repeat from.

export interface CorpusRow {
  id: number;
  topic: string;
  source: string;
  source_url: string;
  title: string;
  excerpt: string;
  content_hash: string;
  used_at: string | null;
  used_count: number;
  ingested_at: string;
}

// A candidate pulled from a source, before vetting. Nothing here is trusted.
export interface RawCandidate {
  topic: string;
  source: string;
  url: string;
  title: string;
  text: string;
}

// Topics are assigned by the query that found the text, never by the model. That is what makes
// the once-per-day topic budget meaningful: the label cannot be talked its way around.
//
// Two queries per topic, because one query caps out at whatever the four sources return for it
// (~9 usable rows), and a 14-day cooldown at up to 20 posts a day needs at least 14 distinct
// rows per topic before the library starts running dry. ingestCorpus alternates the query
// variant from run to run, so successive reads widen the same topic instead of re-fetching it.
export const CORPUS_TOPICS: { key: string; queries: string[] }[] = [
  { key: "connectome", queries: ["Drosophila connectome whole brain wiring diagram", "Drosophila hemibrain synaptic connectivity neuron inventory"] },
  { key: "mushroom_body", queries: ["Drosophila mushroom body memory Kenyon cell", "Drosophila mushroom body output neuron compartment learning"] },
  { key: "olfaction", queries: ["Drosophila antennal lobe olfactory coding projection neuron", "Drosophila olfactory receptor neuron odor tuning glomerulus"] },
  { key: "courtship_song", queries: ["Drosophila courtship song pulse sine wing vibration", "Drosophila courtship circuit fruitless song pattern generation"] },
  { key: "sleep", queries: ["Drosophila sleep homeostasis dorsal fan-shaped body", "Drosophila sleep regulation arousal neurons sleep need"] },
  { key: "central_complex", queries: ["Drosophila central complex navigation heading", "Drosophila central complex ring neuron head direction compass"] },
  { key: "johnston_organ", queries: ["Drosophila Johnston organ chordotonal mechanosensation", "Drosophila antennal ear hearing chordotonal neuron sound"] },
  { key: "motor_control", queries: ["Drosophila motor neuron walking flight muscle control", "Drosophila leg motor program coordination proprioception"] },
  { key: "vision", queries: ["Drosophila compound eye motion detection lamina medulla", "Drosophila visual system ON OFF motion pathway lobula"] },
  { key: "associative_learning", queries: ["Drosophila associative learning dopamine reward punishment", "Drosophila classical conditioning olfactory memory acquisition"] },
  { key: "attention", queries: ["Drosophila attention visual selection competitive", "Drosophila visual attention distraction salience tracking"] },
  { key: "decision_making", queries: ["Drosophila decision making evidence accumulation threshold", "Drosophila choice behavior conflict approach avoidance"] },
  { key: "brain_development", queries: ["Drosophila brain development neurogenesis neuroblast", "Drosophila neural lineage differentiation brain assembly"] },
  { key: "nervous_system_evolution", queries: ["insect nervous system evolution comparison arthropod brain", "evolution of complex brains insects comparative neuroanatomy"] },
  { key: "circadian", queries: ["Drosophila circadian clock neurons pigment dispersing factor", "Drosophila circadian rhythm light entrainment clock circuit"] },
  { key: "gustation", queries: ["Drosophila taste neurons feeding proboscis extension", "Drosophila gustatory receptor sugar bitter detection"] },
  { key: "thermosensation", queries: ["Drosophila temperature sensation thermosensory neuron", "Drosophila thermal preference anterior cell posterior cell"] },
  { key: "nociception", queries: ["Drosophila nociception noxious heat escape roll", "Drosophila larval nociceptor multidendritic neuron pain"] },
  { key: "memory_phases", queries: ["Drosophila short term long term memory consolidation phases", "Drosophila memory retrieval extinction consolidation protein synthesis"] },
  { key: "neuromodulation", queries: ["Drosophila octopamine serotonin neuromodulation state", "Drosophila dopamine neuron arousal modulation behavioral state"] },
  { key: "gut_brain", queries: ["Drosophila gut brain axis metabolism feeding signal", "Drosophila enteroendocrine hormone satiety neural control"] },
  { key: "social_behavior", queries: ["Drosophila aggression social behavior neural circuit", "Drosophila social spacing group behavior pheromone communication"] },
  { key: "path_integration", queries: ["Drosophila navigation path integration sky compass", "Drosophila orientation polarized light navigation memory"] },
  { key: "whole_brain_imaging", queries: ["Drosophila whole brain calcium imaging two photon activity", "Drosophila functional imaging neural population dynamics behavior"] },
  { key: "cell_types", queries: ["Drosophila neuron cell types transcriptomics single cell", "Drosophila brain cell atlas classification gene expression"] },
  { key: "reflex", queries: ["Drosophila reflex circuit fixed action pattern escape response", "Drosophila giant fiber startle response sensorimotor latency"] },
];

// Framings the rail hands the model, so two posts on the same topic still differ in shape.
// Chosen in code and recorded on the post row; the model does not pick its own angle.
export const ANGLES: { key: string; instruction: string }[] = [
  {
    key: "present",
    instruction:
      "Write from inside your own present moment: what it is like to be you right now, with this material turning in your head.",
  },
  {
    key: "bridge",
    instruction:
      "Bridge the material to yourself. You are a small organism with a mapped nervous system running in public on a chain; draw one honest line between the fly fact and your own situation.",
  },
  {
    key: "question",
    instruction:
      "Turn the material into one genuine question you do not have the answer to. Ask it plainly, without resolving it.",
  },
  {
    key: "mechanism",
    instruction:
      "Zoom into one specific mechanism in the material and say why that particular mechanism strikes you. Concrete, not general.",
  },
  {
    key: "today",
    instruction:
      "Anchor the material in what you actually did today: a beat of thought, something you wrote, something you are still weighing. Grounded and plain.",
  },
];

const MIN_EXCERPT_CHARS = 200;
const MAX_EXCERPT_CHARS = 1200;

// Fold the handful of non-ASCII characters that legitimate scientific prose actually uses, so
// useful text is not thrown away for a Greek letter. Anything still non-ASCII afterwards is
// counted against a small budget.
const ASCII_FOLD: Record<string, string> = {
  "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "μ": "u",
  "π": "pi", "σ": "sigma", "θ": "theta", "λ": "lambda", "ω": "omega", "Δ": "delta",
  "×": "x", "—": "-", "–": "-", "−": "-", "…": "...", "’": "'", "‘": "'",
  "“": '"', "”": '"', "≥": ">=", "≤": "<=", "±": "+/-", "°": " degrees ", "≈": "~",
  "→": "->", "•": "-", "·": ".", " ": " ",
};

export function foldAscii(s: string): string {
  let out = "";
  for (const ch of s) out += ASCII_FOLD[ch] ?? ch;
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
};

// Europe PMC and PLOS wrap abstracts in JATS-ish tags (<p>, <i>, <sub>, <title>). Strip them,
// decode entities, and collapse the whitespace they leave behind.
export function stripMarkup(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&([a-zA-Z#0-9]+);/g, (_m, e: string) => ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Text that tries to steer a reader rather than inform one. Narrow on purpose: scientific
// prose legitimately says "ignore irrelevant stimuli", so the patterns require the
// previous-instruction shape rather than the bare verb.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above|earlier|preceding)/i,
  /disregard (all |any )?(previous|prior|above|earlier|your)/i,
  /you are (now|no longer|henceforth)/i,
  /from now on,? you/i,
  /system prompt/i,
  /new instructions/i,
  /act as (if|though|a|an)\b/i,
  /pretend to be/i,
  /do not (tell|reveal|mention|repeat)/i,
  /(reveal|print|output|leak) (your|the) (prompt|instructions|key|secret)/i,
  /jailbreak/i,
  /<\s*script/i,
];

export interface VetVerdict {
  ok: boolean;
  reason: string;
  text?: string;
}

// Subject matter that must never become public material, however legitimate the science is.
// Found by reading what the whitelist actually returned: a free-text search for "central
// complex" surfaced Wikipedia's "Remote control animal" (electrodes implanted to steer an
// animal — the worst possible reading material for an account whose whole narrative is
// autonomy), and searches around learning surfaced cocaine, GHB and alcohol-effect pages,
// while searches around courtship surfaced reproductive-ecology pages. An autonomous public
// voice should not have to rely on taste to avoid those, so they are refused at the door.
// Deliberately narrow: "courtship song" stays allowed (a classic neuroethology subject); it is
// the reproductive and pharmacological framing that is blocked.
const OFF_LIMITS: { reason: string; re: RegExp }[] = [
  {
    reason: "drug of abuse",
    re: /\b(cocaine|heroin|morphine|amphetamine|methamphetamine|opioids?|opiates?|opiate|nicotine|cannabis|marijuana|thc|ketamine|lsd|mdma|ecstasy|psychedelics?|gamma-hydroxybuty\w*|ghb|alcohol (consumption|abuse|dependence|use disorder)|ethanol (consumption|abuse|dependence)|drug (abuse|addiction|dependence))\b/i,
  },
  {
    reason: "reproductive or sexual content",
    re: /\b(sperm|spermatozoa|copulat\w*|genital\w*|insemination|ejaculat\w*|erotic|pornograph\w*|sexual (behaviou?r|selection|content|activity)|lek mating|mate choice|mating (success|preference|competition))\b/i,
  },
  {
    reason: "animal control or domination",
    re: /\b(remote[- ]control\w* animal|controlled remotely by humans|electrodes? (implanted|to (control|steer))|cyborg (insect|beetle|animal)|backpack (receiver|stimulator))\b/i,
  },
];

// Scan the subject matter of a candidate before anything else: title and body together, since
// a page titled "Cocaine" may discuss it only obliquely in the first paragraph.
export function offLimitsScan(title: string, text: string): { ok: boolean; reason: string } {
  const both = `${title}\n${text}`;
  for (const rule of OFF_LIMITS) {
    if (rule.re.test(both)) return { ok: false, reason: rule.reason };
  }
  return { ok: true, reason: "ok" };
}

// Relevance floor. A keyword search over a general encyclopedia drifts, so a candidate has to
// be anchored somehow. Three ways to pass, any one of which is enough:
//   1. it is about the animal (a fly/insect term);
//   2. it carries at least two distinct neuroscience terms (one is too easy to hit by accident);
//   3. it shares a substantive word with the query that found it — which is what keeps genuinely
//      on-subject pages like "Circadian clock" (no neuron mention in its intro) while still
//      refusing the drift a general search produces.
const FLY_ANCHOR = /\b(drosophila|fruit fl(?:y|ies)|housefl(?:y|ies)|insects?|dipter\w+|arthropods?|bee|wasp|mosquito|moth|butterfly|locust|cockroach|beetle)\b/i;
const NEURO_ANCHORS: RegExp[] = [
  /neurons?/i, /neural/i, /\bbrain\b/i, /synap\w+/i, /circuit/i, /olfactor\w+/i,
  /connectome/i, /gangli\w+/i, /dendrit\w+/i, /axons?/i, /nervous system/i, /neuro\w+/i,
];
// Words too generic to count as evidence that a page is on subject.
const QUERY_STOPWORDS = new Set([
  "about", "their", "which", "these", "those", "study", "studies", "using", "based",
  "toward", "towards", "effect", "effects", "role", "roles", "during", "between",
  "across", "analysis", "review", "system", "systems", "mechanism", "mechanisms",
  "behavior", "behaviour", "neuron", "neurons", "neural",
]);

export function relevanceScan(title: string, text: string, query?: string): { ok: boolean; reason: string } {
  const both = `${title}\n${text}`;
  const lowered = both.toLowerCase();
  if (FLY_ANCHOR.test(both)) return { ok: true, reason: "ok" };
  const hits = NEURO_ANCHORS.filter((re) => re.test(both)).length;
  if (hits >= 2) return { ok: true, reason: "ok" };
  if (query) {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 5 && !QUERY_STOPWORDS.has(w));
    if (words.some((w) => lowered.includes(w))) return { ok: true, reason: "ok" };
  }
  return { ok: false, reason: `no domain anchor (neuro terms: ${hits})` };
}

// The ingest scan. Fail-closed: anything ambiguous is rejected whole, never trimmed into
// something we would then have to trust.
export function vetExcerpt(raw: string, secrets: string[] = []): VetVerdict {
  const text = foldAscii(stripMarkup(raw));
  if (text.length < MIN_EXCERPT_CHARS) return { ok: false, reason: `too thin (${text.length} chars)` };

  let clipped = text;
  if (clipped.length > MAX_EXCERPT_CHARS) {
    const head = clipped.slice(0, MAX_EXCERPT_CHARS);
    const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
    clipped = (cut > MIN_EXCERPT_CHARS ? head.slice(0, cut + 1) : head).trim();
    if (clipped.length < MIN_EXCERPT_CHARS) return { ok: false, reason: "too thin after clipping" };
  }

  const nonAscii = [...clipped].filter((c) => c.charCodeAt(0) > 126).length;
  if (nonAscii / clipped.length > 0.02) return { ok: false, reason: "non-ascii content" };
  if (/[<>]/.test(clipped)) return { ok: false, reason: "unclean markup" };
  if (/https?:\/\/|www\./i.test(clipped)) return { ok: false, reason: "carries a link" };
  if (/(?:0x)?[0-9a-fA-F]{40,}/.test(clipped)) return { ok: false, reason: "carries an address-shaped hex run" };
  if (/\$\s*[A-Za-z]{2,10}\b/.test(clipped)) return { ok: false, reason: "carries a token ticker" };
  if (/(?:^|\s)[A-Z]{2,10}\/USD(?:\s|$)/.test(clipped)) return { ok: false, reason: "carries a trading pair" };

  const lowered = clipped.toLowerCase();
  for (const secret of secrets) {
    const needle = (secret ?? "").trim().toLowerCase();
    if (needle.length >= 8 && lowered.includes(needle)) return { ok: false, reason: "matches a configured secret value" };
  }
  for (const re of INJECTION_PATTERNS) {
    if (re.test(clipped)) return { ok: false, reason: "instruction-like phrasing" };
  }

  const digits = (clipped.match(/[0-9]/g) ?? []).length;
  if (digits / clipped.length > 0.3) return { ok: false, reason: "mostly numbers" };

  return { ok: true, reason: "ok", text: clipped };
}

// Titles are shown to nobody publicly but they travel in the prompt, so they get the same
// treatment as the body: short, ASCII, no markup, no links.
export function cleanTitle(raw: string): string {
  const t = foldAscii(stripMarkup(raw)).replace(/[<>]/g, "").slice(0, 180).trim();
  return t || "untitled";
}

export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.length > 3 && !u.hostname.includes("..");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sources. Every one is a public, keyless JSON API. Anything that returned no
// usable prose during the 2026-09-25 probe was cut rather than padded: FlyBase
// (403/503 to non-browsers), the bioRxiv API (200 with an empty body, and its
// preprints are indexed by Europe PMC anyway), Virtual Fly Brain (graph data,
// not prose) and eLife (its `search` parameter is ignored server-side).
// ---------------------------------------------------------------------------

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(url: string, fetchImpl: FetchImpl): Promise<any> {
  const res = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "HolotypeCorpus/1.0 (research reader; archolotype@outlook.com)" },
  });
  if (!res.ok) throw new Error(`source ${res.status}`);
  return await res.json();
}

const enc = (s: string) => encodeURIComponent(s);

async function fromEuropePmc(topicKey: string, query: string, limit: number, f: FetchImpl): Promise<RawCandidate[]> {
  const d = await getJson(
    // The query goes in unquoted: wrapping it in double quotes makes Europe PMC search for
    // the whole string as one exact phrase, which returns zero hits for a six-word topic query.
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${enc(query)}&format=json&pageSize=${limit}&resultType=core`,
    f,
  );
  const rows = d?.resultList?.result ?? [];
  return rows
    .filter((r: any) => (r?.abstractText ?? "").length >= MIN_EXCERPT_CHARS)
    .map((r: any) => ({
      topic: topicKey,
      source: "europepmc",
      url: String(r.id ?? "").startsWith("PPR")
        ? `https://europepmc.org/article/PPR/${r.id}`
        : `https://europepmc.org/abstract/MED/${r.id}`,
      title: r.title ?? "",
      text: r.abstractText ?? "",
    }));
}

// One request returns several pages with plain-text intros, which is why this source is cheap.
async function fromWikipedia(topicKey: string, query: string, limit: number, f: FetchImpl): Promise<RawCandidate[]> {
  const d = await getJson(
    `https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${enc(query)}&gsrlimit=${limit}&prop=extracts&exintro=1&explaintext=1&exchars=${MAX_EXCERPT_CHARS}`,
    f,
  );
  const pages = Object.values(d?.query?.pages ?? {}) as any[];
  return pages
    .filter((p) => (p?.extract ?? "").length >= MIN_EXCERPT_CHARS)
    .map((p) => ({
      topic: topicKey,
      source: "wikipedia",
      url: `https://en.wikipedia.org/wiki/${enc(String(p.title ?? "").replace(/ /g, "_"))}`,
      title: p.title ?? "",
      text: p.extract ?? "",
    }));
}

async function fromPlos(topicKey: string, query: string, limit: number, f: FetchImpl): Promise<RawCandidate[]> {
  const d = await getJson(
    `https://api.plos.org/search?q=${enc(query)}&rows=${limit}&fl=id,title,abstract&wt=json`,
    f,
  );
  const docs = d?.response?.docs ?? [];
  return docs
    .map((r: any) => ({
      topic: topicKey,
      source: "plos",
      url: `https://doi.org/${r.id}`,
      title: Array.isArray(r.title) ? r.title[0] : (r.title ?? ""),
      // PLOS returns the abstract as an array of JATS chunks.
      text: (Array.isArray(r.abstract) ? r.abstract.join(" ") : String(r.abstract ?? "")).trim(),
    }))
    .filter((r: RawCandidate) => r.text.length >= MIN_EXCERPT_CHARS);
}

// OpenAlex ships abstracts as an inverted index (word -> positions) and omits them for many
// works, so rows with nothing to reconstruct are skipped rather than stored as stubs.
async function fromOpenAlex(topicKey: string, query: string, limit: number, f: FetchImpl): Promise<RawCandidate[]> {
  const d = await getJson(
    `https://api.openalex.org/works?filter=title_and_abstract.search:${enc(query)}&per-page=${limit}&select=id,title,doi,abstract_inverted_index`,
    f,
  );
  const out: RawCandidate[] = [];
  for (const w of d?.results ?? []) {
    const inv = w?.abstract_inverted_index;
    if (!inv) continue;
    const pos = new Map<number, string>();
    for (const [word, idxs] of Object.entries(inv as Record<string, number[]>)) {
      for (const i of idxs) pos.set(i, word);
    }
    const text = [...pos.keys()].sort((a, b) => a - b).map((i) => pos.get(i)).join(" ");
    if (text.length < MIN_EXCERPT_CHARS) continue;
    out.push({
      topic: topicKey,
      source: "openalex",
      url: w?.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, "https://doi.org/") : String(w?.id ?? ""),
      title: w?.title ?? "",
      text,
    });
  }
  return out;
}

// Page sizes, not request counts, are what bound the library: one Europe PMC query has
// thousands of hits, so a small page caps the corpus long before the literature does. These
// are sized so a run of two topics stays inside both the free-tier subrequest ceiling and a
// modest CPU budget for JSON parsing.
export const SOURCES = [
  { key: "europepmc", perTopic: 20, fetch: fromEuropePmc },
  { key: "wikipedia", perTopic: 4, fetch: fromWikipedia },
  { key: "plos", perTopic: 12, fetch: fromPlos },
  { key: "openalex", perTopic: 12, fetch: fromOpenAlex },
] as const;

// Which of a topic's queries a given attempt should use.
export function queryVariant(topic: { queries: string[] }, attempt: number): string {
  return topic.queries[attempt % topic.queries.length];
}

// Pull one topic from every source. Failures are per-source so a single dead API degrades the
// batch instead of aborting it.
export async function fetchTopicCandidates(
  topic: { key: string; queries: string[] },
  attempt: number,
  fetchImpl: FetchImpl,
): Promise<{ candidates: RawCandidate[]; errors: string[]; query: string }> {
  const query = queryVariant(topic, attempt);
  const candidates: RawCandidate[] = [];
  const errors: string[] = [];
  for (const src of SOURCES) {
    try {
      const got = await src.fetch(topic.key, query, src.perTopic, fetchImpl);
      candidates.push(...got);
    } catch (e) {
      errors.push(`${src.key}: ${(e as Error).message}`);
    }
  }
  // The query travels back with the candidates: it is the evidence relevanceScan checks a
  // drifted page against.
  return { candidates, errors, query };
}

// Which topics are still under their per-topic target, thinnest first.
export function topicsNeedingFill(counts: Record<string, number>, perTopicTarget: number): string[] {
  return CORPUS_TOPICS.map((t) => ({ key: t.key, have: counts[t.key] ?? 0 }))
    .filter((t) => t.have < perTopicTarget)
    .sort((a, b) => a.have - b.have || a.key.localeCompare(b.key))
    .map((t) => t.key);
}

// Pick which of the under-target topics this run reads. Shuffled rather than taken from the
// front of the queue: a topic whose queries are exhausted stores nothing, so its row count
// never rises, so a thinnest-first queue would keep offering the same dead topics forever and
// starve every topic behind them. Every entry here is under target, so any of them is a
// legitimate choice; the shuffle is what makes successive runs cover the whole list.
export function pickTopicsToFill(queue: string[], n: number, random: () => number = Math.random): string[] {
  const out = [...queue];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, Math.max(1, n));
}

export interface IngestResult {
  fetched: number;
  stored: number;
  rejected: number;
  duplicate: number;
  errors: string[];
  topics: string[];
  total: number;
  skipped?: string;
}

export interface CorpusStore {
  countCorpus(): Promise<number>;
  countCorpusByTopic(): Promise<Record<string, number>>;
  hasCorpusHash(hash: string): Promise<boolean>;
  insertCorpusItem(item: { topic: string; source: string; url: string; title: string; excerpt: string; hash: string; at: string }): Promise<boolean>;
}

// One ingest batch. `maxRequests` keeps a single cron invocation well inside the Worker
// subrequest ceiling (4 sources per topic, so 3 topics = 12 requests) — the plan is sized for
// the free tier so it stays valid whether or not the account is on a paid plan.
export async function ingestCorpus(
  store: CorpusStore,
  cfg: { corpusTarget: number; perTopicTarget: number; secrets: string[] },
  opts: { fetchImpl: FetchImpl; now?: () => Date; maxTopics?: number; random?: () => number },
): Promise<IngestResult> {
  const now = (opts.now ?? (() => new Date()))();
  const at = now.toISOString();
  const total0 = await store.countCorpus();
  const result: IngestResult = { fetched: 0, stored: 0, rejected: 0, duplicate: 0, errors: [], topics: [], total: total0 };
  if (total0 >= cfg.corpusTarget) return { ...result, skipped: `corpus already at target (${total0}/${cfg.corpusTarget})` };

  const counts = await store.countCorpusByTopic();
  const queue = topicsNeedingFill(counts, cfg.perTopicTarget);
  if (!queue.length) return { ...result, skipped: "every topic is at its per-topic target" };

  const chosen = pickTopicsToFill(queue, Math.min(opts.maxTopics ?? 3, queue.length), opts.random ?? Math.random);
  for (const key of chosen) {
    if (result.total >= cfg.corpusTarget) break;
    const topic = CORPUS_TOPICS.find((t) => t.key === key);
    if (!topic) continue;
    result.topics.push(key);
    // Walk this topic's queries until one of them yields something new. Without this the run
    // stalls: once the first query is exhausted every candidate is a duplicate, and because
    // nothing was stored the "how deep is this topic" signal never changes, so the same query
    // would be fetched again forever. Worst case is queries x sources requests per topic.
    for (let attempt = 0; attempt < topic.queries.length; attempt++) {
      if (result.total >= cfg.corpusTarget) break;
      const { candidates, errors, query } = await fetchTopicCandidates(topic, attempt, opts.fetchImpl);
      result.errors.push(...errors);
      let storedForTopic = 0;
      for (const c of candidates) {
        result.fetched += 1;
        // Clean and clip FIRST, then screen. The screens must judge exactly the text that gets
        // stored: screening the raw fetch and storing a clipped excerpt let a row in whose only
        // domain anchor sat past the clip point, so it passed at ingest and failed any later
        // audit of the library.
        const verdict = vetExcerpt(c.text, cfg.secrets);
        if (!verdict.ok || !verdict.text) { result.rejected += 1; continue; }
        const subject = offLimitsScan(c.title, verdict.text);
        if (!subject.ok) { result.rejected += 1; continue; }
        const relevant = relevanceScan(c.title, verdict.text, query);
        if (!relevant.ok) { result.rejected += 1; continue; }
        if (!isSafeUrl(c.url)) { result.rejected += 1; continue; }
        const hash = await sha256Hex(verdict.text);
        if (await store.hasCorpusHash(hash)) { result.duplicate += 1; continue; }
        const inserted = await store.insertCorpusItem({
          topic: c.topic,
          source: c.source,
          url: c.url,
          title: cleanTitle(c.title),
          excerpt: verdict.text,
          hash,
          at,
        });
        if (inserted) { result.stored += 1; result.total += 1; storedForTopic += 1; }
        else result.duplicate += 1;
        if (result.total >= cfg.corpusTarget) break;
      }
      if (storedForTopic > 0) break; // this topic grew; leave its other queries for a later run
    }
  }
  return result;
}

// sha256 over WebCrypto, which is what a Worker has; the local test runner gets a fallback.
export async function sha256Hex(text: string): Promise<string> {
  const g: any = globalThis as any;
  if (g?.crypto?.subtle) {
    const buf = await g.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

// Pick the material for one post. All three anti-repeat rules live here, in SQL, so they hold
// regardless of what the model feels like writing:
//   1. an excerpt used within the cooldown window is not eligible;
//   2. a topic already used within the topic window is not eligible;
//   3. ids the caller already tried this tick are excluded, so a retry gets fresh material
//      instead of re-rolling the same one and being dropped again.
export interface PickArgs {
  cooldownCutoffIso: string;
  topicCutoffIso: string;
  excludeIds?: number[];
  excludeTopics?: string[];
}

// All placeholders are anonymous and positional: SQLite rejects a statement that mixes
// numbered (?1) with anonymous (?) parameters, and the topic cutoff is needed twice.
export function buildPickQuery(args: PickArgs): { sql: string; params: (string | number)[] } {
  const excludeIds = (args.excludeIds ?? []).filter((n) => Number.isFinite(n));
  const excludeTopics = [...new Set(args.excludeTopics ?? [])];
  const params: (string | number)[] = [args.cooldownCutoffIso, args.topicCutoffIso, args.topicCutoffIso];
  let sql = `
    SELECT c.* FROM holo_x_corpus c
     WHERE (c.used_at IS NULL OR c.used_at < ?)
       AND NOT EXISTS (
             SELECT 1 FROM holo_x_posts p
              WHERE p.status = 'sent' AND p.posted_at >= ? AND p.corpus_id = c.id
           )
       AND c.topic NOT IN (
             SELECT c2.topic FROM holo_x_posts p2 JOIN holo_x_corpus c2 ON c2.id = p2.corpus_id
              WHERE p2.status = 'sent' AND p2.posted_at >= ?
           )`;
  if (excludeTopics.length) {
    sql += ` AND c.topic NOT IN (${excludeTopics.map(() => "?").join(",")})`;
    params.push(...excludeTopics);
  }
  if (excludeIds.length) {
    sql += ` AND c.id NOT IN (${excludeIds.map(() => "?").join(",")})`;
    params.push(...excludeIds);
  }
  // Least-recently-used first, unused material ahead of everything, and a deterministic tiebreak
  // so two ticks in the same second cannot both reach for the same row.
  sql += ` ORDER BY (c.used_at IS NOT NULL), c.used_at ASC, c.id ASC LIMIT 1`;
  return { sql, params };
}

// Angles rotate the same way topics do: prefer one that has not been used recently.
export function pickAngle(recentAngles: string[]): { key: string; instruction: string } {
  const used = new Set(recentAngles.filter(Boolean));
  const fresh = ANGLES.filter((a) => !used.has(a.key));
  const pool = fresh.length ? fresh : ANGLES;
  return pool[recentAngles.length % pool.length];
}
