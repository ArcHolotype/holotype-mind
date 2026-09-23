// Deploy-config guard — the executable form of "this Worker is a pure simulation and Holo is ONE brain".
//
// Everything here is asserted against the files on disk, so a careless edit (or a stray `wrangler.toml`
// reappearing) fails `npm test` instead of failing in production. Two classes of mistake are worth more
// than a lint warning:
//   • deploying upstream murmur's real-money config (24 flies, ECONOMY_SHADOW=false, api.muros.live);
//   • anchoring a manifestHash for a brain the deployed Worker does not actually run.
// The sizing numbers below are the ONLY place the 1,080-neuron genome is asserted; when Holo grows to the
// 4,320 tier, change the six BRAIN_* vars in wrangler.holotype.toml and EXPECTED_NEURONS/EXPECTED_DENSITY
// here together — the test failing is the reminder that the on-chain manifest must be re-signed.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type Env } from "./config.js";
import { assembleManifest, manifestHash, replayVerifyManifest } from "./manifest.js";
import { MOTOR_CHANNEL_LIST } from "@fly/fly-brain";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOLO = path.join(pkgRoot, "wrangler.holotype.toml");
const UPSTREAM = path.join(pkgRoot, "wrangler.upstream-murmur.toml");

const EXPECTED_NEURONS = 1080; // 180 + 400 + 400 + 40 + 12×5
const EXPECTED_DENSITY = 0.02;

/** Read a wrangler config's `[vars]` block (quoted `KEY = "value"` lines only). */
function wranglerVars(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inVars = false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { inVars = line.replace(/#.*$/, "").trim() === "[vars]"; continue; }
    if (!inVars || line.startsWith("#") || line === "") continue;
    const m = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const holoText = readFileSync(HOLO, "utf8");
const vars = wranglerVars(HOLO);

test("deploy config: wrangler.toml is gone, so a bare `wrangler deploy` cannot ship upstream's config", () => {
  assert.equal(existsSync(path.join(pkgRoot, "wrangler.toml")), false,
    "a wrangler.toml in packages/trader-worker is what wrangler picks up by default — upstream's is real-money");
  assert.equal(existsSync(HOLO), true, "wrangler.holotype.toml is our only deploy config");
  assert.equal(existsSync(UPSTREAM), true, "upstream's config is kept byte-identical as a diff baseline");
});

test("deploy config: every wrangler script pins --config wrangler.holotype.toml", () => {
  const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
  for (const script of ["dev", "deploy", "tail", "cf-typegen"]) {
    assert.match(pkg.scripts[script], /--config wrangler\.holotype\.toml/,
      `package.json "${script}" must pin our config`);
  }
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(String(cmd), /wrangler\.upstream-murmur\.toml/,
      `package.json "${name}" must never invoke the upstream config`);
  }
});

test("deploy config: identity, routing and cron are the safe ones", () => {
  assert.equal(vars.POPULATION_SIZE, "1", "Holo is one fly");
  assert.equal(vars.SHARD_COUNT, "1");
  assert.match(holoText, /^name = "holotype-dev"$/m);
  assert.doesNotMatch(holoText, /^\s*\[\[?routes/m, "no routes: we must not inherit api.muros.live");
  assert.doesNotMatch(holoText, /custom_domain/, "no custom domain on the body Worker");
  assert.match(holoText, /crons = \["\*\/5 \* \* \* \*"\]/);
});

test("deploy config: no real money can move", () => {
  assert.equal(vars.ECONOMY_FACILITATOR, "simulated");
  assert.equal(vars.ECONOMY_SHADOW, "true");
  assert.equal(vars.ECONOMY_REAL_SPEND, "false");
  assert.equal(vars.ECONOMY_CIRCLE_FACILITATOR, "off");
  for (const gate of ["PREDICT_ENABLED", "ARENA_ENABLED", "WAR_ENABLED", "COMMUNITY_ENABLED",
    "EVOLUTION_ENABLED", "EVOLUTION_HATCH_LIVE", "SIGNAL_ENABLED"]) {
    assert.equal(vars[gate], "false", `${gate} must be off`);
  }
  assert.equal(vars.IPFS_PINNER, "off");
});

test("deploy config: no mainnet contract address is present anywhere in the file", () => {
  // The body worker transacts with nothing: every disabled money feature keeps its address OMITTED
  // so nothing can be inherited or flipped on by accident. The one exception is TOKEN_ADDRESS — a
  // public, READ-ONLY DexScreener lookup key that drives the market temperature. The worker never
  // calls, approves, or transfers that token. Strip exactly that line, then forbid every other
  // 0x…40 address so the invariant stays blunt for all the money features.
  const withoutMarketToken = holoText.replace(/^\s*TOKEN_ADDRESS\s*=\s*"[^"]*"\s*$/m, "");
  assert.equal(/0x[0-9a-fA-F]{40}/.test(withoutMarketToken), false,
    "every disabled feature's address stays omitted, so nothing can be inherited or flipped on by accident");
});

test("deploy config: the connectome is pinned explicitly to Holo's 1,080-neuron genome", () => {
  assert.equal(vars.BRAIN_N_SENSORY, "180");
  assert.equal(vars.BRAIN_N_INTER_L1, "400");
  assert.equal(vars.BRAIN_N_INTER_L2, "400");
  assert.equal(vars.BRAIN_N_MODULATORY, "40");
  assert.equal(vars.BRAIN_N_MOTOR_PER_CHANNEL, "12");
  assert.equal(vars.BRAIN_DENSITY, String(EXPECTED_DENSITY));
});

test("deploy config: those vars, run through the real loader, build a 1,080-neuron brain that replays", async () => {
  const cfg = loadConfig(vars as unknown as Env);
  const manifest = assembleManifest(cfg);
  const c = manifest.connectome as Record<string, number>;
  const total = c.nSensory + c.nInterL1 + c.nInterL2 + c.nModulatory + c.nMotorPerChannel * MOTOR_CHANNEL_LIST.length;
  assert.equal(total, EXPECTED_NEURONS);
  assert.equal(c.density, EXPECTED_DENSITY);
  assert.equal(manifest.population.size, 1);
  assert.equal(manifest.flies.length, 1);
  assert.equal(manifest.flies[0].structural.neuronCount, EXPECTED_NEURONS,
    "the built connectome, not just the arithmetic on the vars");

  const hash = await manifestHash(manifest);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(replayVerifyManifest(manifest).ok, true, "structure must reproduce from the committed seeds");
});

test("manifest tooling: the offline CLI defaults to our config and fails loudly if it is missing", () => {
  const cli = readFileSync(path.join(pkgRoot, "scripts", "replay-brain.ts"), "utf8");
  assert.match(cli, /DEFAULT_WRANGLER = path\.resolve\(here, "\.\.", "wrangler\.holotype\.toml"\)/);
  assert.match(cli, /wrangler config not found/, "a missing config must not silently fall back to code defaults");
});

test("manifest signing: the live Worker is the sole sizing input, cross-checked against our config", () => {
  const signer = readFileSync(path.join(pkgRoot, "scripts", "deploy-manifest-auto.mjs"), "utf8");
  assert.match(signer, /\/manifest/, "signing must fetch the deployed Worker's manifest");
  assert.match(signer, /"--file", liveFile/, "the replay must run on the live body, not a local rebuild");
  assert.doesNotMatch(signer, /"--from-wrangler"/, "a local config rebuild is no longer authoritative");
  assert.match(signer, /CROSS-CHECK|cross-check/i);
  assert.match(signer, /process\.exit\(1\)/);
});
