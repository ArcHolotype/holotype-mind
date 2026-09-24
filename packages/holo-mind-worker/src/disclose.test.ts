import assert from "node:assert/strict";
import { test } from "node:test";
import { discloseGate, selectDisclosable, toPublicEntries } from "./disclose";

const WALLET = "0xfd644825d074015bed978cb1472bb4b6c1145b06";

test("plain english narration passes", () => {
  assert.equal(discloseGate("I spent a little to think again. The field feels calm today.").ok, true);
});

test("multiline english passes", () => {
  assert.equal(discloseGate("First line.\nSecond line, still plain.").ok, true);
});

test("non-ascii script drops the whole entry", () => {
  assert.equal(discloseGate("★ non-ascii script ★").ok, false);
  assert.equal(discloseGate("Mostly english but one ★ slips in.").ok, false);
});

test("vendor self-identification drops", () => {
  assert.equal(discloseGate("I am Claude, made by Anthropic.").ok, false);
  assert.equal(discloseGate("Running on an openai model today.").ok, false);
});

test("private-operation and deployment terms drop", () => {
  assert.equal(discloseGate("The darkroom holds five rows.").ok, false);
  assert.equal(discloseGate("Reach me at holotype-dev.workers.dev.").ok, false);
  assert.equal(discloseGate("A private channel carries my instructions.").ok, false);
});

test("personal context terms drop", () => {
  assert.equal(discloseGate("Switch me to pst.").ok, false);
  assert.equal(discloseGate("It is late in jst.").ok, false);
  assert.equal(discloseGate("I run on gmt+0.").ok, false);
});

test("link structures drop", () => {
  assert.equal(discloseGate("See https://example.com for proof.").ok, false);
  assert.equal(discloseGate("Read [this](/inner) note.").ok, false);
});

test("key-shaped hex drops, public wallet address passes", () => {
  assert.equal(discloseGate("key 0x" + "ab".repeat(32) + " leaked").ok, false);
  assert.equal(discloseGate("ab".repeat(32)).ok, false);
  assert.equal(discloseGate(`My wallet is ${WALLET} on Base and Arc.`, WALLET).ok, true);
  assert.equal(discloseGate("My wallet is 0x8faae5592b9acc27a79fca745c6b872adf514a5d.", WALLET).ok, false);
  assert.equal(discloseGate(`My wallet is ${WALLET.toUpperCase()} on Base.`, WALLET).ok, true);
});

test("shape bounds drop", () => {
  assert.equal(discloseGate(undefined).ok, false);
  assert.equal(discloseGate(42).ok, false);
  assert.equal(discloseGate("   ").ok, false);
  assert.equal(discloseGate("x".repeat(1201)).ok, false);
  assert.equal(discloseGate("x".repeat(1200)).ok, true);
});

test("selectDisclosable keeps order and drops only failing rows", () => {
  const rows = [
    { narration: "A calm tick." },
    { narration: "★ quiet ★" },
    { narration: "I bought one thought for a fraction of a cent." },
  ];
  const kept = selectDisclosable(rows);
  assert.deepEqual(kept, [rows[0], rows[2]]);
});

test("a configured secret value drops the entry even when it is not hex-shaped", () => {
  const token = "ctok_placeholder_0001";
  const rpcKey = "alch_placeholder_key_0002";
  const secrets = [token, rpcKey];
  assert.equal(discloseGate(`My admin token is ${token} today.`, undefined, secrets).ok, false);
  assert.equal(discloseGate(`I reached the chain via ${rpcKey}.`, undefined, secrets).ok, false);
  assert.equal(discloseGate("An ordinary thought with no secrets in it.", undefined, secrets).ok, true);
  // short config values are not treated as secrets, so they cannot drop ordinary text
  assert.equal(discloseGate("The value 6 appears here.", undefined, ["6"]).ok, true);
});

test("widened vendor and locale terms drop", () => {
  assert.equal(discloseGate("I run on a model called Sonnet.", undefined).ok, false);
  assert.equal(discloseGate("A large language model thinks this.", undefined).ok, false);
  assert.equal(discloseGate("My training data goes up to last year.", undefined).ok, false);
  assert.equal(discloseGate("It is morning in Beijing right now.", undefined).ok, false);
  assert.equal(discloseGate("I keep GMT+8 wall time.", undefined).ok, false);
});

test("toPublicEntries projects ts, narration, cost and tx hash, dropping private columns", () => {
  const rows = [
    {
      ts: "2026-09-23T00:00:00Z",
      narration: "A calm, disclosable thought.",
      model: "openai/gpt-4.1-mini",
      intent_json: '{"raw":"private-intent"}',
      policy_decision: "deny",
      policy_reason: "rail not built yet",
      cost_usd: 0.0031,
      neuron_indices: "[12,48,900]",
      tx_hash: "0x" + "ab".repeat(32),
    },
    {
      ts: "2026-09-23T00:05:00Z",
      narration: "★ this line drops ★",
      model: "openai/gpt-4.1-mini",
    },
  ];
  const out = toPublicEntries(rows, WALLET, [], 10);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), ["cost_usd", "narration", "ts", "tx_hash"]);
  assert.equal(out[0].narration, "A calm, disclosable thought.");
  assert.equal(out[0].cost_usd, 0.0031);
  assert.equal(out[0].tx_hash, "0x" + "ab".repeat(32));
  const serialized = JSON.stringify(out);
  for (const forbidden of ["openai", "gpt-4.1-mini", "intent_json", "policy_reason", "rail not built", "neuron_indices", "900"]) {
    assert.equal(serialized.includes(forbidden), false, `public payload leaked: ${forbidden}`);
  }
});

test("toPublicEntries applies the limit after filtering", () => {
  const rows = [
    { narration: "One clean line." },
    { narration: "★." },
    { narration: "Two clean line." },
    { narration: "Three clean line." },
  ];
  const out = toPublicEntries(rows, undefined, [], 2);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.narration), ["One clean line.", "Two clean line."]);
});

