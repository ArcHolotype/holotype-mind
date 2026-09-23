// Config for the Holo mind, all env-overridable.
// SECURITY: the wallet keyfile and the darkroom DB default to paths OUTSIDE the
// git repo (the holotype-internal tree, which is never uploaded). The wallet key
// and the narration are private memory — they must never land in the repo. Paths
// are derived from the home dir at runtime so no machine-specific username is
// ever hardcoded into the committed source.
import { homedir } from "node:os";
import { join } from "node:path";

const INTERNAL = process.env.HOLO_INTERNAL_DIR ?? join(homedir(), "holotype-internal");

export const CONFIG = {
  workerUrl: process.env.HOLO_WORKER_URL ?? "https://holotype-dev.archolotype.workers.dev",
  model: process.env.HOLO_MODEL ?? "openai/gpt-4.1-nano",
  walletKeyfile:
    process.env.HOLO_WALLET_KEYFILE ?? join(INTERNAL, "secrets/holo-base-wallet.key"),
  darkroomDb:
    process.env.HOLO_DARKROOM_DB ?? join(INTERNAL, "data/holo-darkroom.sqlite"),
  // Private creator<->Holo memory: its own encrypted store + master key, separate
  // from the darkroom narration log.
  masterKeyfile:
    process.env.HOLO_MASTER_KEYFILE ?? join(INTERNAL, "secrets/holo-darkroom.key"),
  privateDb:
    process.env.HOLO_PRIVATE_DB ?? join(INTERNAL, "data/holo-private.sqlite"),
  privateContextN: Number(process.env.HOLO_PRIVATE_CONTEXT_N ?? "8"),
  intervalSec: Number(process.env.HOLO_INTERVAL_SEC ?? "900"), // 15-min heartbeat
};
