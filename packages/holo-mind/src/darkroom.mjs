// Holo's private "darkroom" store — narration + intent live ONLY here.
// Physically isolated from the public Journal/chronicle: a separate SQLite file
// outside the repo (never uploaded, never queried by any public page). When this
// is ported into the Worker it becomes the server-side ENCRYPTED private table
// (decision Option A): ciphertext at rest, key in a Cloudflare Secret.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS holo_darkroom (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,
  tick_index      INTEGER,
  temperature     REAL,
  regime          TEXT,
  arousal         REAL,
  valence         REAL,
  behavior        TEXT,
  fap             TEXT,
  model           TEXT,
  narration       TEXT    NOT NULL,
  intent_json     TEXT,
  policy_decision TEXT,
  policy_reason   TEXT
);
`;

export function openDarkroom(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return {
    record(row) {
      const stmt = db.prepare(`
        INSERT INTO holo_darkroom
          (ts, tick_index, temperature, regime, arousal, valence, behavior, fap,
           model, narration, intent_json, policy_decision, policy_reason)
        VALUES
          (@ts, @tick_index, @temperature, @regime, @arousal, @valence, @behavior, @fap,
           @model, @narration, @intent_json, @policy_decision, @policy_reason)
      `);
      const info = stmt.run({
        ts: row.ts ?? new Date().toISOString(),
        tick_index: row.tick_index ?? null,
        temperature: row.temperature ?? null,
        regime: row.regime ?? null,
        arousal: row.arousal ?? null,
        valence: row.valence ?? null,
        behavior: row.behavior ?? null,
        fap: row.fap ?? null,
        model: row.model ?? null,
        narration: row.narration,
        intent_json: row.intent_json ?? null,
        policy_decision: row.policy_decision ?? null,
        policy_reason: row.policy_reason ?? null,
      });
      return Number(info.lastInsertRowid);
    },
    recent(n = 10) {
      return db.prepare(`SELECT * FROM holo_darkroom ORDER BY id DESC LIMIT ?`).all(n);
    },
    count() {
      return db.prepare(`SELECT COUNT(*) AS c FROM holo_darkroom`).get().c;
    },
    close() {
      db.close();
    },
  };
}
