// Local stand-in for the future /creator backend page: a tiny CLI to talk to Holo's
// private, encrypted memory. In production this becomes a token-gated web route; the
// crypto + storage underneath are identical.
//   node src/creator.mjs "your private message / training instruction"
//   node src/creator.mjs --list          # decrypt + show recent (creator-only view)
//   node src/creator.mjs --raw           # show stored CIPHERTEXT (proves no plaintext)
import { CONFIG } from "./config.mjs";
import { loadMasterKey } from "./crypto.mjs";
import { openPrivateMemory } from "./private_memory.mjs";

const arg = process.argv.slice(2).join(" ").trim();

async function main() {
  const key = await loadMasterKey(CONFIG.masterKeyfile);
  const mem = openPrivateMemory(CONFIG.privateDb, key);
  try {
    if (!arg) {
      console.log('usage: creator.mjs "<message>" | --list | --raw');
      return;
    }
    if (arg === "--list") {
      const rows = await mem.recent(20);
      console.log(`private memory (${mem.count()} total), most recent last:`);
      for (const r of rows) console.log(`  #${r.id} [${r.role}] ${r.text}`);
      return;
    }
    if (arg === "--raw") {
      console.log("RAW stored rows (ciphertext only — no plaintext anywhere):");
      for (const r of mem.rawRecent(5))
        console.log(`  #${r.id} [${r.role}] ${r.ciphertext.slice(0, 64)}…`);
      return;
    }
    const id = await mem.add("creator", arg);
    console.log(`stored (encrypted) creator message #${id}; total ${mem.count()}`);
  } finally {
    mem.close();
  }
}

main().catch((e) => {
  console.error("creator error:", e?.message ?? e);
  process.exitCode = 1;
});
