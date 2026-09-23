// Local heartbeat loop: runs beat() on a timer so Holo "beats" on its own.
// Bounded by HOLO_MAX_BEATS (0 = run forever) so a local test never runs away and
// quietly spends. Each beat is isolated — an error is logged, the loop continues.
// Ctrl-C stops it cleanly. This is the LOCAL stand-in for the Worker cron the loop
// becomes once ported into Cloudflare.
import { beat } from "./heartbeat.mjs";
import { CONFIG } from "./config.mjs";

const MAX = Number(process.env.HOLO_MAX_BEATS ?? "0"); // 0 = unlimited
const INTERVAL_MS = Math.max(5, CONFIG.intervalSec) * 1000;
let n = 0, stopping = false;

async function one() {
  n++;
  const t = new Date().toISOString();
  try {
    const r = await beat();
    console.log(`[beat ${n} ${t}] tick=${r.observed.tickIndex} ${r.observed.regime} | ${r.verdict.decision} | row #${r.id}/${r.total} | ${r.narration.slice(0, 70)}`);
  } catch (e) {
    console.error(`[beat ${n} ${t}] ERROR: ${e?.message ?? e}`);
  }
}

function stop(why) {
  if (stopping) return;
  stopping = true;
  console.log(`\nloop stopping (${why}); ran ${n} beat(s).`);
  process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

console.log(`Holo heartbeat loop: interval=${CONFIG.intervalSec}s maxBeats=${MAX || "∞"} model=${CONFIG.model}`);
await one(); // first beat immediately
if (MAX && n >= MAX) stop("reached max beats");
const timer = setInterval(async () => {
  await one();
  if (MAX && n >= MAX) { clearInterval(timer); stop("reached max beats"); }
}, INTERVAL_MS);
