// D1 store layer for the MIND worker. Two isolated tables (see migrations/0001_init.sql):
//   holo_darkroom        — Holo's inner log (narration/intent/verdict/cost).
//   holo_private_memory  — the creator<->Holo channel, ciphertext only (no plaintext column).
// All spend accounting lives here too: each beat records its cost_usd, and the daily
// budget guard sums today's rows. This makes the budget both enforceable and auditable.

import { encrypt, decrypt } from "./crypto.js";

export interface DarkroomRow {
  ts?: string;
  tick_index?: number | null;
  temperature?: number | null;
  regime?: string | null;
  arousal?: number | null;
  valence?: number | null;
  behavior?: string | null;
  fap?: string | null;
  model?: string | null;
  narration: string;
  intent_json?: string | null;
  policy_decision?: string | null;
  policy_reason?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost_usd?: number | null;
  // JSON text array of connectome indices this thought mapped onto (modulatory layer,
  // top-K by MEMBRANE potential — that layer never spikes, so firing rate is identically
  // zero). NULL when the body snapshot was unavailable this beat.
  neuron_indices?: string | null;
}

export async function recordDarkroom(db: D1Database, row: DarkroomRow): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO holo_darkroom
         (ts, tick_index, temperature, regime, arousal, valence, behavior, fap,
          model, narration, intent_json, policy_decision, policy_reason,
          prompt_tokens, completion_tokens, cost_usd, neuron_indices)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
    )
    .bind(
      row.ts ?? new Date().toISOString(),
      row.tick_index ?? null,
      row.temperature ?? null,
      row.regime ?? null,
      row.arousal ?? null,
      row.valence ?? null,
      row.behavior ?? null,
      row.fap ?? null,
      row.model ?? null,
      row.narration,
      row.intent_json ?? null,
      row.policy_decision ?? null,
      row.policy_reason ?? null,
      row.prompt_tokens ?? null,
      row.completion_tokens ?? null,
      row.cost_usd ?? null,
      row.neuron_indices ?? null,
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

export async function recentDarkroom(db: D1Database, n = 10): Promise<any[]> {
  const { results } = await db
    .prepare(`SELECT * FROM holo_darkroom ORDER BY id DESC LIMIT ?1`)
    .bind(n)
    .all();
  return results ?? [];
}

export async function countDarkroom(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS c FROM holo_darkroom`).first<{ c: number }>();
  return Number(r?.c ?? 0);
}

// Sum of cost_usd for rows whose ts starts with the given UTC day prefix ("YYYY-MM-DD").
export async function spendTodayUsd(db: D1Database, dayPrefix: string): Promise<number> {
  const r = await db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM holo_darkroom WHERE ts LIKE ?1`)
    .bind(`${dayPrefix}%`)
    .first<{ s: number }>();
  return Number(r?.s ?? 0);
}

// Lifetime spend across EVERY recorded beat, including beats whose narration never
// passed the disclosure gate (they still paid on-chain). Powers the public Metabolism
// total, so the displayed figure is the true spend, not just the published subset.
export async function spendSummary(db: D1Database): Promise<{ total_usd: number; beats: number }> {
  const r = await db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS s, COUNT(*) AS c FROM holo_darkroom`)
    .first<{ s: number; c: number }>();
  return { total_usd: Number(r?.s ?? 0), beats: Number(r?.c ?? 0) };
}

// ---- x402 settlement evidence ----

export interface UnhashedBeat {
  id: number;
  ts: string;
  cost_usd: number | null;
  tx_hash: string | null;
}

// Beats not yet linked to their on-chain settlement tx (newest first).
export async function unhashedBeats(db: D1Database): Promise<UnhashedBeat[]> {
  const { results } = await db
    .prepare(`SELECT id, ts, cost_usd, tx_hash FROM holo_darkroom WHERE tx_hash IS NULL ORDER BY id DESC`)
    .all<any>();
  return (results ?? []) as UnhashedBeat[];
}

export async function setTxHash(db: D1Database, id: number, txHash: string): Promise<void> {
  await db.prepare(`UPDATE holo_darkroom SET tx_hash = ?1 WHERE id = ?2`).bind(txHash, id).run();
}

// ---- sync cursor (holo_sync_state) ----

export async function getSyncState(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare(`SELECT value FROM holo_sync_state WHERE key = ?1`).bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSyncState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(`INSERT INTO holo_sync_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, value)
    .run();
}

// ---- private (creator<->Holo) memory: encrypt before write, decrypt only in-process ----

export async function addPrivate(
  db: D1Database,
  key: CryptoKey,
  role: string,
  text: string,
): Promise<number> {
  const ciphertext = await encrypt(key, text);
  const res = await db
    .prepare(`INSERT INTO holo_private_memory (ts, role, ciphertext) VALUES (?1,?2,?3)`)
    .bind(new Date().toISOString(), role, ciphertext)
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

// Most recent n rows (oldest->newest), decrypted in-process.
export async function recentPrivate(
  db: D1Database,
  key: CryptoKey,
  n = 8,
): Promise<{ id: number; ts: string; role: string; text: string }[]> {
  const { results } = await db
    .prepare(`SELECT id, ts, role, ciphertext FROM holo_private_memory ORDER BY id DESC LIMIT ?1`)
    .bind(n)
    .all<any>();
  const rows = (results ?? []).slice().reverse();
  const out: { id: number; ts: string; role: string; text: string }[] = [];
  for (const r of rows) {
    out.push({ id: r.id, ts: r.ts, role: r.role, text: await decrypt(key, r.ciphertext) });
  }
  return out;
}

// Raw ciphertext rows — proves the DB holds no plaintext. Never decrypts.
export async function rawPrivate(db: D1Database, n = 5): Promise<any[]> {
  const { results } = await db
    .prepare(`SELECT id, role, ciphertext FROM holo_private_memory ORDER BY id DESC LIMIT ?1`)
    .bind(n)
    .all();
  return results ?? [];
}

export async function countPrivate(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS c FROM holo_private_memory`).first<{ c: number }>();
  return Number(r?.c ?? 0);
}

// ---- Nectar missions (holo_missions, migration 0005) ----
// Updates are deliberately narrow, parameterized setters (no dynamic column names), so
// the SQL is fixed and injection-free by construction. Money never moves from here: a
// payment still needs a fresh approval JSON plus the separate fail-closed payment rail.

export interface MissionRow {
  id: number;
  ts: string;
  title: string;
  description: string;
  criteria: string; // JSON array of strings
  reward_cents: number;
  chain: string;
  status: string;
  claimant: string | null;
  delivery: string | null; // JSON
  approval: string | null; // JSON
  tx_hash: string | null;
  updated_at: string;
}

const nowIso = () => new Date().toISOString();

export async function createMission(
  db: D1Database,
  m: { title: string; description: string; criteria: string[]; rewardCents: number; chain?: string },
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO holo_missions (ts, title, description, criteria, reward_cents, chain, status, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,'open',?7)`,
    )
    .bind(nowIso(), m.title, m.description, JSON.stringify(m.criteria), m.rewardCents, m.chain ?? "arc", nowIso())
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

export async function getMission(db: D1Database, id: number): Promise<MissionRow | null> {
  return (await db.prepare(`SELECT * FROM holo_missions WHERE id = ?1`).bind(id).first<MissionRow>()) ?? null;
}

export async function listMissions(
  db: D1Database,
  opts: { status?: string; limit?: number } = {},
): Promise<MissionRow[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  if (opts.status) {
    const { results } = await db
      .prepare(`SELECT * FROM holo_missions WHERE status = ?1 ORDER BY id DESC LIMIT ?2`)
      .bind(opts.status, limit)
      .all<MissionRow>();
    return results ?? [];
  }
  const { results } = await db.prepare(`SELECT * FROM holo_missions ORDER BY id DESC LIMIT ?1`).bind(limit).all<MissionRow>();
  return results ?? [];
}

const touch = (db: D1Database, id: number) =>
  db.prepare(`UPDATE holo_missions SET updated_at = ?1 WHERE id = ?2`).bind(nowIso(), id).run();

export async function setMissionStatus(db: D1Database, id: number, status: string): Promise<void> {
  await db.prepare(`UPDATE holo_missions SET status = ?1 WHERE id = ?2`).bind(status, id).run();
  await touch(db, id);
}

export async function setMissionClaim(db: D1Database, id: number, claimant: string): Promise<void> {
  await db.prepare(`UPDATE holo_missions SET claimant = ?1, status = 'claimed' WHERE id = ?2`).bind(claimant, id).run();
  await touch(db, id);
}

export async function setMissionDelivery(db: D1Database, id: number, deliveryJson: string): Promise<void> {
  await db.prepare(`UPDATE holo_missions SET delivery = ?1, status = 'submitted' WHERE id = ?2`).bind(deliveryJson, id).run();
  await touch(db, id);
}

export async function setMissionApproval(db: D1Database, id: number, approvalJson: string): Promise<void> {
  await db.prepare(`UPDATE holo_missions SET approval = ?1, status = 'approved' WHERE id = ?2`).bind(approvalJson, id).run();
  await touch(db, id);
}

export async function setMissionTxHash(db: D1Database, id: number, txHash: string): Promise<void> {
  await db.prepare(`UPDATE holo_missions SET tx_hash = ?1, status = 'completed' WHERE id = ?2`).bind(txHash, id).run();
  await touch(db, id);
}

// Missions created since the start of the given UTC day ("YYYY-MM-DD") — backs the
// code-enforced 3-tasks/24h cap.
export async function countMissionsSince(db: D1Database, dayPrefix: string): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*) AS c FROM holo_missions WHERE ts LIKE ?1`)
    .bind(`${dayPrefix}%`)
    .first<{ c: number }>();
  return Number(r?.c ?? 0);
}

// Sum of reward_cents reserved by non-cancelled missions created today — combined with
// today's LLM spend this backs the unified $30/24h cap at mission-creation time.
export async function sumReservedTodayCents(db: D1Database, dayPrefix: string): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(reward_cents), 0) AS s FROM holo_missions
       WHERE ts LIKE ?1 AND status NOT IN ('cancelled')`,
    )
    .bind(`${dayPrefix}%`)
    .first<{ s: number }>();
  return Number(r?.s ?? 0);
}

// ---- Mission counterparty blacklist (holo_mission_blacklist, migration 0009) ----
// Best-effort containment for injection-shaped deliveries: a key is the lowercased claimant
// string or a payout address. Rotation to a fresh key bypasses it, so the hard loss bound
// remains the per-mission / per-day reward caps, not this table.
export interface BlacklistRow {
  id: number;
  bkey: string;
  kind: string;
  reason: string | null;
  ts: string;
}

export async function isBlacklisted(db: D1Database, bkey: string): Promise<boolean> {
  const k = String(bkey ?? "").trim().toLowerCase();
  if (!k) return false;
  const r = await db.prepare(`SELECT 1 AS hit FROM holo_mission_blacklist WHERE bkey = ?1`).bind(k).first();
  return !!r;
}

export async function addBlacklist(db: D1Database, bkey: string, kind: string, reason: string): Promise<void> {
  const k = String(bkey ?? "").trim().toLowerCase();
  if (!k) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO holo_mission_blacklist (bkey, kind, reason, ts) VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(k, kind, reason.slice(0, 200), nowIso())
    .run();
}

export async function listBlacklist(db: D1Database, limit = 100): Promise<BlacklistRow[]> {
  const n = Math.min(500, Math.max(1, limit));
  const { results } = await db
    .prepare(`SELECT id, bkey, kind, reason, ts FROM holo_mission_blacklist ORDER BY id DESC LIMIT ?1`)
    .bind(n)
    .all<BlacklistRow>();
  return results ?? [];
}

// ---- X (Twitter) self-broadcast log (holo_x_posts, migration 0007) ----
// Backs the broadcast rail's code-enforced guards: the every-N-hours cadence and per-day
// caps count from posted_at over SENT rows only (a candidate the gate dropped never posted,
// so it must not consume budget), and the no-repeat rule dedups against recent dedup_hash
// values. Holds no key and moves no money.

export interface XPostRow {
  id: number;
  kind: string;
  text: string;
  dedup_hash: string;
  ref: string | null;
  trigger: string | null;
  status: string;
  gate_reason: string | null;
  opentweet_id: string | null;
  in_reply_to: string | null;
  posted_at: string;
  corpus_id: number | null;
  angle: string | null;
}

export async function recordXPost(
  db: D1Database,
  row: {
    kind: "post" | "reply";
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
  },
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO holo_x_posts
         (kind, text, dedup_hash, ref, trigger, status, gate_reason, opentweet_id, in_reply_to, posted_at, corpus_id, angle)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
    )
    .bind(
      row.kind,
      row.text,
      row.dedupHash,
      row.ref ?? null,
      row.trigger ?? null,
      row.status ?? "sent",
      row.gateReason ?? null,
      row.opentweetId ?? null,
      row.inReplyTo ?? null,
      row.postedAt ?? nowIso(),
      row.corpusId ?? null,
      row.angle ?? null,
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

// Count of SENT rows of a kind since the start of the given UTC day ("YYYY-MM-DD").
export async function countXSentSince(db: D1Database, dayPrefix: string, kind: "post" | "reply"): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*) AS c FROM holo_x_posts WHERE posted_at LIKE ?1 AND kind = ?2 AND status = 'sent'`)
    .bind(`${dayPrefix}%`, kind)
    .first<{ c: number }>();
  return Number(r?.c ?? 0);
}

// posted_at of the most recent SENT row of a kind, or null when none — backs the cadence gate.
export async function lastXSentAt(db: D1Database, kind: "post" | "reply"): Promise<string | null> {
  const r = await db
    .prepare(`SELECT posted_at FROM holo_x_posts WHERE kind = ?1 AND status = 'sent' ORDER BY id DESC LIMIT 1`)
    .bind(kind)
    .first<{ posted_at: string }>();
  return r?.posted_at ?? null;
}

// dedup_hash of the most recent n SENT rows (any kind) — backs the exact-duplicate gate.
export async function recentXHashes(db: D1Database, n = 40): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT dedup_hash FROM holo_x_posts WHERE status = 'sent' ORDER BY id DESC LIMIT ?1`)
    .bind(Math.min(200, Math.max(1, n)))
    .all<{ dedup_hash: string }>();
  return (results ?? []).map((r) => r.dedup_hash);
}

// text of the most recent n SENT rows (any kind) — backs the near-duplicate similarity gate.
export async function recentXTexts(db: D1Database, n = 40): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT text FROM holo_x_posts WHERE status = 'sent' ORDER BY id DESC LIMIT ?1`)
    .bind(Math.min(200, Math.max(1, n)))
    .all<{ text: string }>();
  return (results ?? []).map((r) => r.text);
}

// Most recent n SENT posts (newest first) — Holo's own published history, fed back as
// narrative context so it knows what it has already said on its account.
export async function recentXPosts(db: D1Database, n = 20): Promise<XPostRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM holo_x_posts WHERE status = 'sent' ORDER BY id DESC LIMIT ?1`)
    .bind(Math.min(200, Math.max(1, n)))
    .all<XPostRow>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// Daily counting for the broadcast rail.
//
// Two ceilings, because OpenTweet's plan limit is a single bucket that every kind of post
// draws from: a global ceiling across all kinds, and a lower ceiling on self-posts so an
// event broadcast (a mission published, a payment settled) always has room left. Both are
// counted from SENT rows in the log — never from a cached counter, which is how the rail
// once mistook a published post for a failed one and nearly reposted it all day.
// ---------------------------------------------------------------------------

// Every SENT row today, any kind. This is the number that must stay under the plan limit.
export async function countXSentAllToday(db: D1Database, dayPrefix: string): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*) AS c FROM holo_x_posts WHERE posted_at LIKE ?1 AND status = 'sent'`)
    .bind(`${dayPrefix}%`)
    .first<{ c: number }>();
  return Number(r?.c ?? 0);
}

// SENT cadence (self-authored) posts today — the number the floor and the self-ceiling apply to.
export async function countXSelfSentToday(db: D1Database, dayPrefix: string): Promise<number> {
  const r = await db
    .prepare(`SELECT COUNT(*) AS c FROM holo_x_posts WHERE posted_at LIKE ?1 AND status = 'sent' AND trigger = 'cadence'`)
    .bind(`${dayPrefix}%`)
    .first<{ c: number }>();
  return Number(r?.c ?? 0);
}

// Angles of the most recent SENT posts, newest first — backs angle rotation.
export async function recentXAngles(db: D1Database, n = 5): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT angle FROM holo_x_posts WHERE status = 'sent' AND angle IS NOT NULL ORDER BY id DESC LIMIT ?1`)
    .bind(Math.min(50, Math.max(1, n)))
    .all<{ angle: string | null }>();
  return (results ?? []).map((r) => String(r.angle ?? "")).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Corpus: Holo's reading material (see src/corpus.ts for why the posting path reads only this).
// ---------------------------------------------------------------------------

export async function countCorpus(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS c FROM holo_x_corpus`).first<{ c: number }>();
  return Number(r?.c ?? 0);
}

export async function countCorpusByTopic(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(`SELECT topic, COUNT(*) AS c FROM holo_x_corpus GROUP BY topic`)
    .all<{ topic: string; c: number }>();
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.topic] = Number(r.c);
  return out;
}

export async function hasCorpusHash(db: D1Database, hash: string): Promise<boolean> {
  const r = await db
    .prepare(`SELECT id FROM holo_x_corpus WHERE content_hash = ?1 LIMIT 1`)
    .bind(hash)
    .first<{ id: number }>();
  return !!r;
}

// Returns false when the row already exists (the UNIQUE content_hash rejects it), which the
// caller counts as a duplicate rather than an error.
export async function insertCorpusItem(
  db: D1Database,
  item: { topic: string; source: string; url: string; title: string; excerpt: string; hash: string; at: string },
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO holo_x_corpus (topic, source, source_url, title, excerpt, content_hash, ingested_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    )
    .bind(item.topic, item.source, item.url, item.title, item.excerpt, item.hash, item.at)
    .run();
  return Number(res.meta.changes ?? 0) > 0;
}

// Stamp an excerpt as used once a post that drew on it is actually SENT. Stamping only on
// success matters: a dropped draft must not burn material, or a run of unlucky drafts would
// eat the library without publishing anything.
export async function markCorpusUsed(db: D1Database, corpusId: number, at: string): Promise<void> {
  await db
    .prepare(`UPDATE holo_x_corpus SET used_at = ?2, used_count = used_count + 1 WHERE id = ?1`)
    .bind(corpusId, at)
    .run();
}

// Bind the D1 store to the ingest port so corpus.ts stays free of any D1 dependency.
export function corpusStore(db: D1Database): import("./corpus.js").CorpusStore {
  return {
    countCorpus: () => countCorpus(db),
    countCorpusByTopic: () => countCorpusByTopic(db),
    hasCorpusHash: (hash) => hasCorpusHash(db, hash),
    insertCorpusItem: (item) => insertCorpusItem(db, item),
  };
}

// Read the library back. This exists so the creator can inspect exactly what Holo is allowed
// to read — the corpus is not a black box, and every post records which row it drew on.
export async function listCorpus(
  db: D1Database,
  n = 20,
  topic?: string | null,
): Promise<import("./corpus.js").CorpusRow[]> {
  const limit = Math.min(200, Math.max(1, n));
  const q = topic
    ? db
        .prepare(`SELECT * FROM holo_x_corpus WHERE topic = ?1 ORDER BY id DESC LIMIT ?2`)
        .bind(topic, limit)
    : db.prepare(`SELECT * FROM holo_x_corpus ORDER BY id DESC LIMIT ?1`).bind(limit);
  const { results } = await q.all<import("./corpus.js").CorpusRow>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// Schedule: when the next self-post becomes eligible.
// ---------------------------------------------------------------------------

export interface XScheduleRow {
  next_eligible_at: string;
  last_gap_minutes: number | null;
  updated_at: string;
}

export async function getXSchedule(db: D1Database): Promise<XScheduleRow> {
  const r = await db
    .prepare(`SELECT next_eligible_at, last_gap_minutes, updated_at FROM holo_x_schedule WHERE id = 1`)
    .first<XScheduleRow>();
  return r ?? { next_eligible_at: "1970-01-01T00:00:00.000Z", last_gap_minutes: null, updated_at: "1970-01-01T00:00:00.000Z" };
}

export async function setXSchedule(db: D1Database, nextEligibleAt: string, lastGapMinutes: number | null, at: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO holo_x_schedule (id, next_eligible_at, last_gap_minutes, updated_at) VALUES (1, ?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET next_eligible_at = ?1, last_gap_minutes = ?2, updated_at = ?3`,
    )
    .bind(nextEligibleAt, lastGapMinutes, at)
    .run();
}

