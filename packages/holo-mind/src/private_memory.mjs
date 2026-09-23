// Holo's PRIVATE memory: the creator<->Holo channel, encrypted at rest.
// Stored in its OWN SQLite file, physically separate from both the public Journal
// and Holo's darkroom narration log. The table holds ONLY ciphertext — there is no
// plaintext column anywhere. Decryption happens in-process, only with the master
// key, only in the two authorised places (creator backend + Holo heartbeat).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { encrypt, decrypt } from "./crypto.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS holo_private_memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  role       TEXT NOT NULL,          -- 'creator' | 'holo'
  ciphertext TEXT NOT NULL           -- AES-GCM blob; NEVER plaintext
);
`;

export function openPrivateMemory(dbPath, key) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return {
    // Encrypts before writing. Returns the new row id.
    async add(role, text) {
      const ciphertext = await encrypt(key, text);
      const info = db
        .prepare(
          `INSERT INTO holo_private_memory (ts, role, ciphertext) VALUES (?, ?, ?)`,
        )
        .run(new Date().toISOString(), role, ciphertext);
      return Number(info.lastInsertRowid);
    },
    // Reads the most recent n rows (oldest->newest) and decrypts them in-process.
    async recent(n = 8) {
      const rows = db
        .prepare(`SELECT id, ts, role, ciphertext FROM holo_private_memory ORDER BY id DESC LIMIT ?`)
        .all(n);
      const out = [];
      for (const r of rows.reverse()) {
        out.push({ id: r.id, ts: r.ts, role: r.role, text: await decrypt(key, r.ciphertext) });
      }
      return out;
    },
    // Raw ciphertext rows — for proving the DB holds no plaintext. Never decrypts.
    rawRecent(n = 5) {
      return db
        .prepare(`SELECT id, role, ciphertext FROM holo_private_memory ORDER BY id DESC LIMIT ?`)
        .all(n);
    },
    count() {
      return db.prepare(`SELECT COUNT(*) AS c FROM holo_private_memory`).get().c;
    },
    close() {
      db.close();
    },
  };
}
