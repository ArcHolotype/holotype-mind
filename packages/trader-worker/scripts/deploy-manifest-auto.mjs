// Fully-automatic NeuralManifestRegistry deployment + brain-manifest commitment for murmur.
//
// This is the "prove the brain, trustlessly" anchor. It does TWO irreversible-ish things in one run:
//   1. deploys contracts/NeuralManifestRegistry.sol (a pure commitment log — holds NO funds, no upgrade),
//   2. commits the AUTHORITATIVE production manifestHash to it, after re-running the offline replay so a
//      manifest that does not reproduce from its committed seeds is NEVER anchored.
//
// The manifestHash is NOT computed from what a config file says the brain should be. It comes from the LIVE
// deployed Worker: we fetch GET /manifest from it, cross-check that body against wrangler.holotype.toml, then
// hand it to the verified offline CLI (scripts/replay-brain.ts --file), which recomputes the hash and rebuilds
// every connectome from the committed seeds. The CLI must report PASS (exit 0) or we abort — so a brain that
// does not reproduce from its own seeds, or a live Worker out of sync with our deploy config, is NEVER anchored.
//
// SAFETY / CHAIN SELECTION (this spends gas, so mainnet is gated):
//   • DEFAULT is Arc TESTNET (CHAIN_ID 5042002) — a zero-real-money dry run of the whole flow.
//   • Deploying to Arc MAINNET (5042) additionally requires MANIFEST_CONFIRM=1 in the environment.
//
// You fill packages/trader-worker/.env.local with ONE of (the SAME shape deploy-registry-auto.mjs uses):
//   MANIFEST_DEPLOYER_PK   (any gas wallet key — deploys AND is the committer, so it can commit)
//   ECONOMY_FACILITATOR_PK (a dedicated gas key)
//   ECONOMY_MNEMONIC       (the Worker seed — we derive the identical facilitator wallet)
// then run:  node scripts/deploy-manifest-auto.mjs
//
// The committer defaults to the deployer so THIS script can commit; override with MANIFEST_COMMITTER (then
// the deploy-only path runs and the commit is skipped, since only the committer may commit). The secret key
// is never printed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// ---- read .env.local (KEY=VALUE, # comments, blank lines) ----
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    // Strip one layer of matching surrounding quotes (standard .env convention): KEY="0x.." or KEY='0x..'.
    // Without this, a quoted value would be fed to normPk as `"0x.."` -> `0x"0x.."` -> invalid private key.
    let val = line.slice(i + 1).trim();
    const q = val[0];
    if (val.length >= 2 && (q === '"' || q === "'") && val[val.length - 1] === q) val = val.slice(1, -1).trim();
    out[line.slice(0, i).trim()] = val;
  }
  return out;
}

// ---- read a wrangler config's [vars] (quoted KEY = "value" lines only) ----
// Used purely as a CROSS-CHECK against the live Worker's manifest, never as the source of truth.
function parseWranglerVars(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  let inVars = false;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { inVars = line.replace(/#.*$/, "").trim() === "[vars]"; continue; }
    if (!inVars || line.startsWith("#") || line === "") continue;
    const m = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const envFile = path.join(root, ".env.local");
const env = { ...readEnv(envFile) };
// Run-scoped knobs: an EXPLICIT process.env value WINS over .env.local. This matters because production
// .env.local may pin CHAIN_ID=5042 (mainnet); an explicit `CHAIN_ID=5042002 npm run deploy:manifest` must
// reliably target testnet regardless. Absent a process.env value we fall back to .env.local (or the default).
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "CHAIN_ID", "MANIFEST_CONFIRM", "MANIFEST_COMMITTER", "MANIFEST_HASH", "MANIFEST_WORKER_URL"]) {
  if (process.env[k]) env[k] = process.env[k];
}

// ---- proxy (Node's global fetch/undici honours the global dispatcher) ----
const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;
if (proxy) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxy));
  console.log("proxy    :", proxy);
}

// ---- chain: DEFAULT TESTNET; mainnet requires an explicit MANIFEST_CONFIRM=1 ----
const chainId = Number(env.CHAIN_ID || "5042002");
const isMainnet = chainId === 5042;
if (isMainnet && (env.MANIFEST_CONFIRM || "").trim() !== "1") {
  console.error("\n✗ Refusing a mainnet deploy: CHAIN_ID=5042 requires MANIFEST_CONFIRM=1 to be set explicitly (deploying the contract spends real gas and cannot be undone).");
  console.error("  Run against testnet first (CHAIN_ID=5042002, the default) to validate the whole path, then consider mainnet.");
  process.exit(1);
}
const rpcUrl = env.RPC_URL || (isMainnet ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io");
const chain = {
  id: chainId,
  name: isMainnet ? "Arc Mainnet" : "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

// ---- resolve the deployer / committer account (same derivation as the Worker) ----
const FACILITATOR_ACCOUNT_INDEX = 2_000_000; // must match src/keys.ts
const normPk = (s) => (s.startsWith("0x") ? s : `0x${s}`);
const isHexKey = (s) => /^(0x)?[0-9a-fA-F]{64}$/.test(s.trim());
let account;
if (env.MANIFEST_DEPLOYER_PK) {
  account = privateKeyToAccount(normPk(env.MANIFEST_DEPLOYER_PK.trim()));
  console.log("key src  : MANIFEST_DEPLOYER_PK");
} else if (env.ECONOMY_FACILITATOR_PK) {
  account = privateKeyToAccount(normPk(env.ECONOMY_FACILITATOR_PK.trim()));
  console.log("key src  : ECONOMY_FACILITATOR_PK");
} else if (env.ECONOMY_MNEMONIC) {
  const m = env.ECONOMY_MNEMONIC.trim();
  if (isHexKey(m)) {
    account = privateKeyToAccount(normPk(m)); // a raw PK was pasted into the mnemonic field
    console.log("key src  : ECONOMY_MNEMONIC field held a raw hex private key (used as PK)");
  } else {
    account = mnemonicToAccount(m, { accountIndex: FACILITATOR_ACCOUNT_INDEX });
    console.log("key src  : ECONOMY_MNEMONIC (derived facilitator, accountIndex " + FACILITATOR_ACCOUNT_INDEX + ")");
  }
} else {
  console.error("\n✗ No key. Put ECONOMY_MNEMONIC or a private key in packages/trader-worker/.env.local, then run this again.");
  process.exit(1);
}

// committer defaults to the deployer (so this script can commit). An explicit override ⇒ deploy-only.
const committerOverride = (env.MANIFEST_COMMITTER || "").trim();
const committer = committerOverride || account.address;
const canCommit = committer.toLowerCase() === account.address.toLowerCase();

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });
const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "build", "NeuralManifestRegistry.json"), "utf8"));

console.log("chain    :", chainId, isMainnet ? "(MAINNET — MANIFEST_CONFIRM ok)" : "(testnet)", rpcUrl);
console.log("deployer :", account.address, "(pays gas)");
console.log("committer:", committer, canCommit ? "(= deployer)" : "(override — deploy-only, commit skipped)");

// ---- gas sanity ----
const bal = await publicClient.getBalance({ address: account.address });
console.log("deployer gas bal:", (Number(bal) / 1e18).toFixed(6), "USDC(native)");
if (bal === 0n) {
  console.error("\n✗ The deployer balance is 0, so the deploy gas cannot be paid. Fund that address with native USDC first.");
  process.exit(1);
}

// ---- the LIVE deployed Worker is the SOLE sizing input ----
// Fetch the manifest the deployed Worker actually serves, cross-check it against our deploy config, then let
// the offline CLI recompute the hash and replay every connectome from the committed seeds. Refuse to sign if
// any of the three disagree: an unsynced Worker, an unpinned var, or an unreproducible brain.
const liveBase = (env.MANIFEST_WORKER_URL || env.BODY_WORKER_URL || "https://holotype-dev.archolotype.workers.dev").replace(/\/+$/, "");
const HOLO_CONFIG = path.join(root, "wrangler.holotype.toml");

let manifestHashHex = (env.MANIFEST_HASH || "").trim().replace(/^0x/i, "");
let schemaVersion = 1;
let population = 0;
if (manifestHashHex) {
  console.log("manifest : using MANIFEST_HASH from env (skipping live fetch + replay)");
} else {
  const buildDir = path.join(root, "contracts", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const liveFile = path.join(buildDir, "LIVE_MANIFEST.json");
  const manifestFile = path.join(buildDir, "PRODUCTION_MANIFEST.json");
  const hashFile = path.join(buildDir, "PRODUCTION_MANIFEST_HASH.txt");

  console.log("manifest : fetching the LIVE brain from", liveBase + "/manifest");
  let live;
  let liveSelfHash = "";
  try {
    const res = await fetch(liveBase + "/manifest");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.json();
    live = body.manifest ?? body;
    liveSelfHash = String(body.manifestHash ?? "").replace(/^0x/i, "").toLowerCase();
  } catch (e) {
    console.error("\n✗ Could not fetch /manifest from the live Worker (" + (e?.message ?? e) + ").");
    console.error("  The live brain is the only authority — nothing is anchored without it. Set MANIFEST_WORKER_URL to point somewhere else.");
    process.exit(1);
  }
  if (live?.schema !== "murmur-brain-manifest") {
    console.error("✗ /manifest did not return a brain manifest (schema=" + live?.schema + ")");
    process.exit(1);
  }
  fs.writeFileSync(liveFile, JSON.stringify(live, null, 2));

  // ---- cross-check: live brain vs wrangler.holotype.toml ----
  const vars = parseWranglerVars(HOLO_CONFIG);
  const c = live.connectome || {};
  const checks = [
    ["chainId", live.chainId, vars.CHAIN_ID],
    ["population.size", live.population?.size, vars.POPULATION_SIZE],
    ["population.seedBase", live.population?.seedBase, vars.POPULATION_SEED_BASE],
    ["connectome.nSensory", c.nSensory, vars.BRAIN_N_SENSORY],
    ["connectome.nInterL1", c.nInterL1, vars.BRAIN_N_INTER_L1],
    ["connectome.nInterL2", c.nInterL2, vars.BRAIN_N_INTER_L2],
    ["connectome.nModulatory", c.nModulatory, vars.BRAIN_N_MODULATORY],
    ["connectome.nMotorPerChannel", c.nMotorPerChannel, vars.BRAIN_N_MOTOR_PER_CHANNEL],
    ["connectome.density", c.density, vars.BRAIN_DENSITY],
  ];
  console.log("manifest : cross-checking the live brain against wrangler.holotype.toml");
  const bad = [];
  for (const [label, liveVal, cfgVal] of checks) {
    const ok = cfgVal !== undefined && String(liveVal) === String(cfgVal);
    console.log("  " + (ok ? "✓" : "✗") + " " + label.padEnd(28) + " live=" + liveVal + "  config=" + (cfgVal ?? "(NOT PINNED)"));
    if (!ok) bad.push(label);
  }
  if (bad.length) {
    console.error("\n✗ The live brain disagrees with the deploy config (" + bad.join(", ") + ") — refusing to anchor.");
    console.error("  Either wrangler.holotype.toml does not pin those vars, or the config changed and the worker was not redeployed. Align them first, then sign.");
    process.exit(1);
  }

  // ---- offline replay of the LIVE manifest (hash recompute + every connectome rebuilt from its seeds) ----
  console.log("manifest : replaying the live brain offline (hash + structure) …");
  try {
    execFileSync("npx", ["tsx", "scripts/replay-brain.ts", "--file", liveFile, "--out", manifestFile, "--out-hash", hashFile], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32", // npx is a .cmd shim on Windows
    });
  } catch (e) {
    console.error("\n✗ The replay CLI failed (non-zero exit) — the live brain cannot be rebuilt from its committed seeds, refusing to anchor.");
    process.exit(1);
  }
  manifestHashHex = fs.readFileSync(hashFile, "utf8").trim().replace(/^0x/i, "");
  const body = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  schemaVersion = Number(body.v ?? 1);
  population = Number(body.population?.size ?? 0);
  if (!/^[0-9a-fA-F]{64}$/.test(manifestHashHex)) {
    console.error("✗ The replay CLI did not produce a valid manifestHash");
    process.exit(1);
  }
  // The Worker publishes its own hash; ours is recomputed independently. A mismatch means the served body and
  // the served hash disagree — i.e. the endpoint is broken or lying — so we do not anchor either.
  if (liveSelfHash && liveSelfHash !== manifestHashHex.toLowerCase()) {
    console.error("\n✗ The live worker's self-reported manifestHash (" + liveSelfHash + ") != our independently recomputed hash (" + manifestHashHex + ") — refusing to anchor.");
    process.exit(1);
  }
  console.log("manifest : hash 0x" + manifestHashHex + (liveSelfHash ? " (= worker self-report ✓)" : ""));
  console.log("manifest : schemaVersion", schemaVersion, "· population", population);
}
const manifestHashBytes32 = `0x${manifestHashHex}`;

// ---- deploy ----
console.log("\ndeploying NeuralManifestRegistry …");
const deployTx = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [committer] });
console.log("deploy tx:", deployTx);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTx, confirmations: 1 });
if (receipt.status !== "success") { console.error("✗ The deploy transaction reverted"); process.exit(1); }
const address = receipt.contractAddress;
console.log("registry :", address);

// ---- self-verify the deployed immutables ----
const onchainCommitter = await publicClient.readContract({ address, abi: artifact.abi, functionName: "committer" });
console.log("verify   : committer =", onchainCommitter, onchainCommitter.toLowerCase() === committer.toLowerCase() ? "✓" : "✗ MISMATCH");

// ---- commit the production manifestHash (only if this key is the committer) ----
if (canCommit) {
  console.log("\ncommitting brain manifest …");
  const commitTx = await wallet.writeContract({
    address,
    abi: artifact.abi,
    functionName: "commit",
    args: [manifestHashBytes32, schemaVersion, population],
  });
  console.log("commit tx:", commitTx);
  const commitReceipt = await publicClient.waitForTransactionReceipt({ hash: commitTx, confirmations: 1 });
  if (commitReceipt.status !== "success") { console.error("✗ The commit transaction reverted"); process.exit(1); }
  const committed = await publicClient.readContract({ address, abi: artifact.abi, functionName: "isCommitted", args: [manifestHashBytes32] });
  const latest = await publicClient.readContract({ address, abi: artifact.abi, functionName: "latestHash" });
  console.log("verify   : isCommitted =", committed, committed ? "✓" : "✗");
  console.log("verify   : latestHash  =", latest, latest.toLowerCase() === manifestHashBytes32.toLowerCase() ? "✓" : "✗ MISMATCH");
} else {
  console.log("\n⚠ MANIFEST_COMMITTER != deployer: deployed only, nothing committed. Have the committer call commit(" + manifestHashBytes32 + ", " + schemaVersion + ", " + population + ") itself.");
}

// ---- persist the address for the Worker wiring step ----
fs.writeFileSync(path.join(root, "contracts", "MANIFEST_REGISTRY_ADDRESS.txt"), address + "\n");
let envTxt = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
if (/^\s*MANIFEST_REGISTRY_ADDRESS\s*=/m.test(envTxt)) {
  envTxt = envTxt.replace(/^\s*MANIFEST_REGISTRY_ADDRESS\s*=.*$/m, `MANIFEST_REGISTRY_ADDRESS=${address}`);
} else {
  envTxt += `\nMANIFEST_REGISTRY_ADDRESS=${address}\n`;
}
fs.writeFileSync(envFile, envTxt);

console.log("\n✅ NeuralManifestRegistry deployed" + (canCommit ? ", and the production brain manifest committed." : " (nothing committed)."));
console.log("Address:", address, "· chain", chainId);
console.log("Wrote contracts/MANIFEST_REGISTRY_ADDRESS.txt and .env.local (MANIFEST_REGISTRY_ADDRESS).");
console.log("Next step: put that address into MANIFEST_REGISTRY_ADDRESS in wrangler.holotype.toml and redeploy the Worker (the assistant does this only after you sign off).");
