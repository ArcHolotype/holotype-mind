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
