// Deterministic policy gate. The LLM only EMITS an intent; this hardcoded layer
// — not the model — decides whether anything actually happens. Money, publishing
// and self-modification rails are NOT built yet, so every intent that would touch
// them is rejected here. The narration is always kept (it moves nothing).
const ALLOWED = new Set(["observe", "narrate", "rest", "reflect", "idle"]);

// Intents that are categorically refused until their approval rail exists.
const FORBIDDEN = {
  spend: "real-money spend requires per-tx human approval (rail not built yet)",
  transfer: "on-chain transfer requires per-tx human approval (rail not built yet)",
  buy: "self-purchase (x402) not wired into the policy gate yet",
  post_tweet: "publishing requires a creator-approved content boundary (not set yet)",
  publish: "publishing requires a creator-approved content boundary (not set yet)",
  self_modify: "self-modification proposals need the pipeline + human sign-off",
  breed: "reproduction is gated behind evolution arming + approval",
};

export function decide(intent) {
  if (!intent || typeof intent !== "object") {
    return { decision: "REJECTED", reason: "no parseable intent object" };
  }
  const type = String(intent.type ?? "").toLowerCase().trim();
  if (!type) return { decision: "REJECTED", reason: "intent.type missing" };
  if (FORBIDDEN[type]) return { decision: "REJECTED", reason: FORBIDDEN[type] };
  if (ALLOWED.has(type)) {
    return { decision: "ALLOWED", reason: "safe internal intent (moves no money, publishes nothing)" };
  }
  return { decision: "REJECTED", reason: `unknown intent type "${type}" (default-deny)` };
}
