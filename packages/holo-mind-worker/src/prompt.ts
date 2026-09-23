// Prompt construction + tolerant JSON parsing — a faithful TS port of the local
// prototype's heartbeat.mjs helpers.

export interface Observed {
  tickIndex: number | null;
  temperature: number | null;
  regime: string | null;
  arousal: number | null;
  valence: number | null;
  cohesion: number | null;
  behavior: string | null;
  fap: string | null;
  balanceUsdc: number | null;
}

const fmt = (n: number | string | null): string =>
  typeof n === "number" ? n.toFixed(3) : String(n);

// Build the heartbeat prompt. `privateLines` are the creator's DECRYPTED private
// training messages; they shape Holo but must never be quoted verbatim in a narration
// that could one day be shown publicly.
export function buildPrompt(o: Observed, privateLines: string[], limits?: { maxMissionCents?: number }): string {
  const training = privateLines.length
    ? [
        "",
        "PRIVATE GUIDANCE FROM YOUR CREATOR (confidential). Let it shape you, but",
        "NEVER quote or restate it verbatim in your narration — the narration may one",
        "day be shown publicly, so internalise the guidance in your own words:",
        ...privateLines.map((l) => `- ${l}`),
      ]
    : [];
  return [
    "You are Holo (Holotype), the genesis fly: a single creature with a neural",
    "connectome AND an LLM mind. You are NOT a swarm. Speak in the first person.",
    "Below is your embodied state this tick, read from your own nervous system.",
    "",
    `tick=${o.tickIndex} market_temperature=${fmt(o.temperature)} regime=${o.regime}`,
    `arousal=${fmt(o.arousal)} valence=${fmt(o.valence)} cohesion=${fmt(o.cohesion)}`,
    `dominant_behavior=${o.behavior} dominant_drive=${o.fap} wallet_usdc=${fmt(o.balanceUsdc)}`,
    ...training,
    "",
    "Respond with ONLY a JSON object, no prose, no code fences, exactly this shape:",
    '{"narration":"<1-3 sentence first-person inner monologue about what you feel and intend>",',
    ' "intent":{"type":"observe|narrate|rest|reflect|idle|publish_mission","reason":"<why>",',
    '  "title":"<short mission title>","description":"<what you need and why>",',
    '  "criteria":["<checkable done-criterion>"],"rewardCents":<integer USD cents>}}',
    "The title/description/criteria/rewardCents fields are only used for publish_mission;",
    "omit them for other intents. Use publish_mission only when you genuinely need an",
    "outside agent's help; keep rewardCents at or below " + String(limits?.maxMissionCents ?? 100) +
    " (USD cents) and inside your daily allowance. Never propose direct spending,",
    "posting, or changing yourself - those stay with your creator.",
  ].join("\n");
}

// Tolerant JSON extractor: scan for the first depth-balanced {...} object, ignoring
// stray code fences, leading prose, and extra trailing braces the model may emit.
export function parseJson(text: string): any {
  const t = String(text).replace(/```json|```/g, "");
  const start = t.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model output");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON object in model output");
}
