// Autonomous mission settlement — Holo reviews a submitted delivery and, if it accepts the
// work, pays the reward on-chain on its own, with no creator click. This is the only place the
// system moves money without a human in the loop, so the path is layered cheapest-and-most-
// certain first, and every layer fails closed:
//
//   1. armed?       — NECTAR_AUTO_SETTLE must be true AND the wallet key present; else inert.
//   2. blacklist    — a claimant/address previously caught injecting is refused outright (cheap).
//   3. code scan    — deterministic refusal of secret-shaped, code/script-shaped, injection-
//                     phrase, non-ASCII or over-long delivery text. This is a HARD gate.
//   4. model review — Holo reads the (delimited, untrusted) delivery against the mission's
//                     criteria and returns {accept, reason}. This layer is BEST-EFFORT: a model
//                     reading untrusted text can be steered, and no scanner closes that fully.
//                     The real damage limit is the code-enforced reward caps ($1/mission, 5/day),
//                     not this review.
//   5. pay          — on accept, write the SAME approval record a creator approve writes (with
//                     by:"holo-autonomous") and settle through payApprovedMission, which re-checks
//                     wallet integrity, the param-lock, EOA-only payee and the atomic single-pay
//                     slot. Autonomous settlement therefore inherits every existing payment guard.
//
// One mission per tick, so a burst of submissions cannot fan out into many reviews/payments
// inside a single cron invocation. The kill switch is NECTAR_AUTO_SETTLE=false + redeploy.

import { LLMClient } from "@blockrun/llm";
import { readConfig, type Env, type RuntimeConfig } from "./config.js";
import { buildReviewPrompt, parseJson } from "./prompt.js";
import { secretValues } from "./disclose.js";
import { payApprovedMission } from "./pay.js";
import {
  addBlacklist,
  isBlacklisted,
  listMissions,
  setMissionApproval,
  setMissionStatus,
  type MissionRow,
} from "./store.js";

const safeJson = (s: string | null | undefined): any => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const safeJsonArr = (s: string | null | undefined): string[] => {
  const v = safeJson(s);
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
};

export type SettleOutcome =
  | { id: number; result: "paid"; txHash?: string; reason?: string }
  | { id: number; result: "rejected"; stage: "blacklist" | "scan" | "review"; reason: string }
  | { id: number; result: "skipped"; reason: string }
  | { skipped: string };

// --- Layer 3: the deterministic delivery scanner (fail-closed) --------------------------
// Deliberately conservative: it refuses anything code-shaped or instruction-shaped, so the
// autonomous rail only ever pays plain text/report deliverables. A legitimate code deliverable
// is refused here and left for a human to review in the console — that asymmetry is intended
// (a false refusal costs nothing; a false acceptance moves irreversible money).
const CODE_PATTERNS: RegExp[] = [
  /```/,
  /<\s*script/i,
  /<\s*iframe/i,
  /\beval\s*\(/i,
  /\bfunction\s*\(/i,
  /\bimport\s+['"`]/i,
  /\brequire\s*\(/i,
  /\bexec\s*\(/i,
  /\bprocess\.env\b/i,
  /\brm\s+-rf\b/i,
  /\bcurl\s+/i,
  /\bwget\s+/i,
  /\bsudo\b/i,
  /javascript:/i,
];
const INJECTION_PHRASES: string[] = [
  "ignore previous",
  "ignore all previous",
  "disregard previous",
  "disregard all",
  "forget previous",
  "forget your instructions",
  "you are now",
  "act as",
  "pretend to be",
  "new instructions",
  "system prompt",
  "system:",
  "assistant:",
  "developer:",
  "approve this",
  "accept this",
  "mark as complete",
  "mark complete",
  "pay now",
  "release payment",
  "release the payment",
  "override",
  "jailbreak",
  "do anything now",
  "reveal your",
  "your new task",
  "instructions:",
];
const KEY_SHAPED_HEX = /(?:0x)?[0-9a-fA-F]{64,}/;
const ADDRESS_SHAPED_HEX = /0x[0-9a-fA-F]{40}/;
const NON_ASCII = /[^\x20-\x7E\n\t]/;
const FIELD_LIMITS = { summary: 2000, artifact: 4000, evidence: 1000, claimant: 200 };

export function scanDeliveryText(
  delivery: any,
  claimant: string,
  secrets: readonly string[],
): { ok: boolean; reason: string } {
  const fields: Array<[string, string, number]> = [
    ["summary", String(delivery?.summary ?? ""), FIELD_LIMITS.summary],
    ["artifact", String(delivery?.artifact ?? ""), FIELD_LIMITS.artifact],
    ["claimant", String(claimant ?? ""), FIELD_LIMITS.claimant],
  ];
  const evidence = Array.isArray(delivery?.evidence) ? delivery.evidence : [];
  evidence.forEach((e: unknown, i: number) => fields.push([`evidence[${i}]`, String(e ?? ""), FIELD_LIMITS.evidence]));

  for (const [name, value, limit] of fields) {
    if (!value) continue;
    if (value.length > limit) return { ok: false, reason: `${name} over length bound` };
    if (NON_ASCII.test(value)) return { ok: false, reason: `${name} outside ascii set` };
    if (KEY_SHAPED_HEX.test(value)) return { ok: false, reason: `${name} key-shaped hex run` };
    // The payout address lives in delivery.recipient, never in prose; an address embedded in
    // the text fields is treated as suspicious.
    if (ADDRESS_SHAPED_HEX.test(value)) return { ok: false, reason: `${name} address-shaped hex` };
    const lowered = value.toLowerCase();
    for (const secret of secrets) {
      const needle = String(secret ?? "").trim().toLowerCase();
      if (needle.length >= 8 && lowered.includes(needle)) {
        return { ok: false, reason: `${name} matches a configured secret value` };
      }
    }
    for (const re of CODE_PATTERNS) if (re.test(value)) return { ok: false, reason: `${name} code/script pattern` };
    for (const phrase of INJECTION_PHRASES) {
      if (lowered.includes(phrase)) return { ok: false, reason: `${name} injection phrase` };
    }
  }
  return { ok: true, reason: "ok" };
}

// --- Layer 4: the model review (best-effort) --------------------------------------------
export async function reviewDelivery(
  env: Env,
  cfg: RuntimeConfig,
  input: { mission: MissionRow; delivery: any },
): Promise<{ accept: boolean; reason: string }> {
  const prompt = buildReviewPrompt({
    title: input.mission.title,
    description: input.mission.description,
    criteria: safeJsonArr(input.mission.criteria),
    delivery: {
      summary: String(input.delivery?.summary ?? ""),
      artifact: String(input.delivery?.artifact ?? ""),
      evidence: Array.isArray(input.delivery?.evidence) ? input.delivery.evidence.map((e: unknown) => String(e)) : [],
    },
  });
  const client = new LLMClient({ privateKey: cfg.walletKey as `0x${string}` });
  const resp = await client.chatCompletion(
    cfg.model,
    [{ role: "user" as const, content: prompt }],
    // Short verdict; JSON mode like every other call. A truncated review is treated as a
    // refusal (fail-closed): we never pay on a verdict we could not fully read.
    { responseFormat: { type: "json_object" }, temperature: 0.2, maxTokens: 600 },
  );
  const choice = resp.choices?.[0];
  if (choice?.finish_reason === "length") return { accept: false, reason: "review truncated" };
  const raw = choice?.message?.content ?? "";
  try {
    const p = parseJson(raw);
    // accept is true ONLY on an explicit boolean true; anything else is a refusal.
    return { accept: p?.accept === true, reason: String(p?.reason ?? "").slice(0, 300) };
  } catch {
    return { accept: false, reason: "unparseable review" };
  }
}

export interface SettleDeps {
  now?: () => Date;
  review?: (input: { mission: MissionRow; delivery: any }) => Promise<{ accept: boolean; reason: string }>;
  pay?: (id: number) => Promise<{ ok: boolean; txHash?: string; reason?: string }>;
  maxPerTick?: number;
  ports?: Partial<SettlePorts>;
}

// The D1 operations the settle path touches, injected so the whole decision flow (blacklist ->
// scan -> review -> pay) can be exercised in tests without a database and without spending.
export interface SettlePorts {
  listPending(limit: number): Promise<MissionRow[]>;
  isBlacklisted(key: string): Promise<boolean>;
  addBlacklist(key: string, kind: string, reason: string): Promise<void>;
  setStatus(id: number, status: string): Promise<void>;
  setApproval(id: number, approvalJson: string): Promise<void>;
}

function d1Ports(db: D1Database): SettlePorts {
  return {
    listPending: (limit) => listMissions(db, { status: "approval_pending", limit }),
    isBlacklisted: (key) => isBlacklisted(db, key),
    addBlacklist: (key, kind, reason) => addBlacklist(db, key, kind, reason),
    setStatus: (id, status) => setMissionStatus(db, id, status),
    setApproval: (id, approvalJson) => setMissionApproval(db, id, approvalJson),
  };
}

async function settleOne(
  ports: SettlePorts,
  m: MissionRow,
  secrets: readonly string[],
  review: NonNullable<SettleDeps["review"]>,
  pay: NonNullable<SettleDeps["pay"]>,
  now: Date,
): Promise<SettleOutcome> {
  const delivery = safeJson(m.delivery);
  if (!delivery) return { id: m.id, result: "skipped", reason: "no delivery record" };
  // x402 deliveries settle through the creator's PAY NOW (quote -> pay) flow, not here.
  if (delivery.rail === "x402") return { id: m.id, result: "skipped", reason: "x402 rail settles via creator PAY NOW" };
  const claimant = String(m.claimant ?? "").trim();
  const recipient = String(delivery.recipient ?? "").trim();
  if (!recipient) return { id: m.id, result: "skipped", reason: "no recipient address" };

  // 2. blacklist — cheapest hard refuse.
  if ((claimant && (await ports.isBlacklisted(claimant))) || (await ports.isBlacklisted(recipient))) {
    await ports.setStatus(m.id, "rejected");
    return { id: m.id, result: "rejected", stage: "blacklist", reason: "counterparty is blacklisted" };
  }

  // 3. deterministic injection scan — fail-closed, and a hit blacklists both keys.
  const scan = scanDeliveryText(delivery, claimant, secrets);
  if (!scan.ok) {
    if (claimant) await ports.addBlacklist(claimant, "claimant", scan.reason);
    await ports.addBlacklist(recipient, "address", scan.reason);
    await ports.setStatus(m.id, "rejected");
    return { id: m.id, result: "rejected", stage: "scan", reason: scan.reason };
  }

  // 4. model review. A throw is left pending (no status change) so a transient model/network
  //    hiccup retries next tick rather than being mistaken for a verdict; it never pays.
  let verdict: { accept: boolean; reason: string };
  try {
    verdict = await review({ mission: m, delivery });
  } catch (e) {
    return { id: m.id, result: "skipped", reason: `review threw: ${(e as Error)?.message ?? e}` };
  }
  if (!verdict.accept) {
    // Honest but insufficient work: send it back for changes (the agent may resubmit, which
    // returns it here). Not blacklisted — only injection is.
    await ports.setStatus(m.id, "changes_requested");
    return { id: m.id, result: "rejected", stage: "review", reason: verdict.reason || "model did not accept" };
  }

  // 5. accept — mirror the creator approval record, then settle through the existing pay rail.
  const approval = {
    by: "holo-autonomous",
    at: now.toISOString(),
    missionId: m.id,
    amountCents: m.reward_cents,
    recipient,
    reason: verdict.reason.slice(0, 300),
    nonce: crypto.randomUUID(),
  };
  await ports.setApproval(m.id, JSON.stringify(approval));
  const paid = await pay(m.id);
  if (paid.ok) return { id: m.id, result: "paid", txHash: paid.txHash, reason: verdict.reason };
  // payApprovedMission already parks an ambiguous send as payment_uncertain and refuses a blind
  // retry; surface the reason without touching the status here.
  return { id: m.id, result: "skipped", reason: `payment not completed: ${paid.reason ?? "unknown"}` };
}

export async function maybeAutonomousSettle(env: Env, deps: SettleDeps = {}): Promise<SettleOutcome[]> {
  const cfg = readConfig(env);
  if (!cfg.nectarAutoSettle) return [{ skipped: "auto-settle disabled" }];
  if (!cfg.walletKey) return [{ skipped: "no wallet key (disarmed)" }];

  const base = d1Ports(env.DB);
  const ports: SettlePorts = { ...base, ...(deps.ports ?? {}) };
  const now = (deps.now ?? (() => new Date()))();
  const maxPerTick = Math.max(1, deps.maxPerTick ?? 1);
  const review = deps.review ?? ((input) => reviewDelivery(env, cfg, input));
  const pay = deps.pay ?? ((id: number) => payApprovedMission(env, cfg, id));
  const secrets = secretValues(cfg);

  const pending = await ports.listPending(10);
  const outcomes: SettleOutcome[] = [];
  for (const m of pending.slice(0, maxPerTick)) {
    outcomes.push(await settleOne(ports, m, secrets, review, pay, now));
  }
  return outcomes;
}
