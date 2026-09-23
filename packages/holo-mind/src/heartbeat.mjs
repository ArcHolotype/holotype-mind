// One Holo heartbeat:
//   observe live neural state -> LLM emits {narration, intent} -> deterministic
//   policy gate decides -> narration + decision written to the isolated darkroom.
// LOCAL ONLY: reads the worker's public /state, spends a fraction of a cent on one
// LLM call, moves no money and publishes nothing. Exported as beat() so loop.mjs
// can run it on a timer; runs once when invoked directly.
import { LLMClient } from "@blockrun/llm";
import { readFileSync } from "node:fs";
import { CONFIG } from "./config.mjs";
import { openDarkroom } from "./darkroom.mjs";
import { decide } from "./policy.mjs";
import { loadMasterKey } from "./crypto.mjs";
import { openPrivateMemory } from "./private_memory.mjs";

const fmt = (n) => (typeof n === "number" ? n.toFixed(3) : String(n));

// 1) OBSERVE — read Holo's embodied state off the live worker (read-only, no money).
async function observe() {
  const r = await fetch(`${CONFIG.workerUrl}/state`);
  if (!r.ok) throw new Error(`worker /state ${r.status}`);
  const s = await r.json();
  const c = s.collective ?? {};
  return {
    tickIndex: s.tickIndex ?? null,
    temperature: c.temperature ?? s.market?.temperature ?? null,
    regime: c.regime ?? s.market?.regime ?? null,
    arousal: c.arousal ?? null,
    valence: c.valence ?? null,
    cohesion: c.cohesion ?? null,
    behavior: Object.entries(c.states ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    fap: Object.entries(c.faps ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    balanceUsdc: s.economy?.meanBalanceUsdc ?? null,
  };
}

// 2) THINK — one LLM call; the model must return STRICT JSON only.
function buildPrompt(o, privateLines) {
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
    ' "intent":{"type":"observe|narrate|rest|reflect|idle","reason":"<why>"}}',
    "Do not propose spending money, posting, or changing yourself.",
  ].join("\n");
}

// Tolerant JSON extractor: scan for the first depth-balanced {...} object, ignoring
// stray code fences, leading prose, and extra trailing braces the model may emit.
function parseJson(text) {
  const t = String(text).replace(/```json|```/g, "");
  const start = t.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model output");
  let depth = 0, inStr = false, esc = false;
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

export async function beat() {
  const o = await observe();

  // Load the creator's private training messages (decrypted in-process only).
  let privateLines = [];
  const key = await loadMasterKey(CONFIG.masterKeyfile);
  const mem = openPrivateMemory(CONFIG.privateDb, key);
  try {
    const recent = await mem.recent(CONFIG.privateContextN);
    privateLines = recent.map((m) => `[${m.role}] ${m.text}`);
  } finally {
    mem.close();
  }

  process.env.BASE_CHAIN_WALLET_KEY = readFileSync(CONFIG.walletKeyfile, "utf8").trim();
  const client = new LLMClient();
  const raw = await client.chat(CONFIG.model, buildPrompt(o, privateLines));

  let intent, narration, parseErr = null;
  try {
    const parsed = parseJson(raw);
    narration = String(parsed.narration ?? "").trim() || String(raw).slice(0, 280);
    intent = parsed.intent ?? { type: "narrate", reason: "model returned no intent" };
  } catch (e) {
    parseErr = e.message;
    narration = String(raw).slice(0, 280);
    intent = { type: "narrate", reason: `unparseable JSON (${e.message})` };
  }

  const verdict = decide(intent);
  const store = openDarkroom(CONFIG.darkroomDb);
  const id = store.record({
    tick_index: o.tickIndex,
    temperature: o.temperature,
    regime: o.regime,
    arousal: o.arousal,
    valence: o.valence,
    behavior: o.behavior,
    fap: o.fap,
    model: CONFIG.model,
    narration,
    intent_json: JSON.stringify(intent),
    policy_decision: verdict.decision,
    policy_reason: verdict.reason,
  });
  const total = store.count();
  store.close();

  return {
    id, total, parseErr,
    observed: o, model: CONFIG.model, narration, intent, verdict,
  };
}

// Run once when invoked directly: `npm run beat`
if (import.meta.url === `file://${process.argv[1]}`) {
  beat()
    .then((r) => {
      console.log("=== Holo heartbeat ===");
      console.log(`observed   : tick=${r.observed.tickIndex} temp=${fmt(r.observed.temperature)} regime=${r.observed.regime} arousal=${fmt(r.observed.arousal)} valence=${fmt(r.observed.valence)} behavior=${r.observed.behavior} drive=${r.observed.fap}`);
      console.log(`model      : ${r.model}${r.parseErr ? ` (JSON parse fell back: ${r.parseErr})` : ""}`);
      console.log(`narration  : ${r.narration}`);
      console.log(`intent     : ${JSON.stringify(r.intent)}`);
      console.log(`policy     : ${r.verdict.decision} — ${r.verdict.reason}`);
      console.log(`darkroom   : wrote row #${r.id} (total ${r.total}) -> ${CONFIG.darkroomDb}`);
    })
    .catch((e) => {
      console.error("HEARTBEAT ERROR:", e?.message ?? e);
      process.exitCode = 1;
    });
}
