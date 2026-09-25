// Deterministic policy gate — a faithful TS port of the local prototype's policy.mjs.
// The LLM only EMITS an intent; THIS hardcoded layer (not the model) decides whether
// anything happens. Money, publishing and self-modification rails are NOT built, so
// every intent that would touch them is rejected here. The narration is always kept
// (it moves nothing). Default-deny: an unknown intent type is rejected.

export interface Intent {
  type?: string;
  reason?: string;
  [k: string]: unknown;
}

export interface Verdict {
  decision: "ALLOWED" | "REJECTED";
  reason: string;
}

// publish_mission is AUTONOMOUS (no creator approval to publish): it moves no money at
// intent time. The volume/budget/per-mission caps plus the disclosure gate bind it at
// creation. Creator approval is still required later for delivery acceptance and
// for payment (PAY NOW).
const ALLOWED = new Set(["observe", "narrate", "rest", "reflect", "idle", "publish_mission"]);

// buy: the brain may PROPOSE an x402 purchase, but a proposal moves no money and fetches
// nothing. Execution is a separate creator-gated rail (prepare -> PAY NOW) bounded by the
// x402 per-purchase + daily caps, an EOA-only payee check, the approval param-lock and the
// atomic single-pay claim. So the intent is allowed to be RECORDED; nothing is bought until
// the creator explicitly pays. (Kept out of ALLOWED so its verdict reason is specific.)
const GATED_PROPOSAL = new Set(["buy"]);

// Intents categorically refused until their approval rail exists.
//
// post_tweet/publish stay REFUSED as brain intents ON PURPOSE. X posting is not a model
// decision: it runs only through the worker-controlled broadcast rail (src/xtweet.ts) on a
// cadence + on real mission/settlement events, behind the fail-closed disclosure/identity/
// topic/dedup/frequency gate. So even a hijacked model that emits post_tweet cannot post —
// the speaking path is separate from the intent path, and from the wallet signing path.
const FORBIDDEN: Record<string, string> = {
  spend: "real-money spend requires per-tx human approval (rail not built yet)",
  transfer: "on-chain transfer requires per-tx human approval (rail not built yet)",
  post_tweet: "X posting runs only through the gated worker broadcast rail, never as a model intent",
  publish: "X posting runs only through the gated worker broadcast rail, never as a model intent",
  self_modify: "self-modification proposals need the pipeline + human sign-off",
  breed: "reproduction is gated behind evolution arming + approval",
};

export function decide(intent: Intent | null | undefined): Verdict {
  if (!intent || typeof intent !== "object") {
    return { decision: "REJECTED", reason: "no parseable intent object" };
  }
  const type = String(intent.type ?? "").toLowerCase().trim();
  if (!type) return { decision: "REJECTED", reason: "intent.type missing" };
  if (FORBIDDEN[type]) return { decision: "REJECTED", reason: FORBIDDEN[type] };
  if (GATED_PROPOSAL.has(type)) {
    return {
      decision: "ALLOWED",
      reason: "purchase proposal recorded; execution requires creator PAY NOW via the x402 buyer rail",
    };
  }
  if (ALLOWED.has(type)) {
    return { decision: "ALLOWED", reason: "safe internal intent (moves no money at intent time)" };
  }
  return { decision: "REJECTED", reason: `unknown intent type "${type}" (default-deny)` };
}
