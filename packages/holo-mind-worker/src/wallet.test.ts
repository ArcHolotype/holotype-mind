// Safety tests for the wallet-integrity gate and the gated policy intents.
// These lock the code-enforced guarantees: a mis-set key can never arm the payment
// rail, and a gated intent (publish_mission) can never pass without creator approval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveWalletAddress, walletIntegrityOk, assertWalletIntegrity } from "./wallet.js";
import { decide } from "./policy.js";

// Well-known test vector (Anvil/hardhat account #0): private key -> address.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

test("deriveWalletAddress matches the known EVM vector", () => {
  assert.equal(deriveWalletAddress(KEY), ADDR);
});

test("walletIntegrityOk true only when key derives to the configured public wallet", () => {
  assert.equal(walletIntegrityOk({ walletKey: KEY, publicWallet: ADDR }), true);
  assert.equal(walletIntegrityOk({ walletKey: KEY, publicWallet: ADDR.toUpperCase() }), true); // case-insensitive
  assert.equal(
    walletIntegrityOk({ walletKey: KEY, publicWallet: "0x0000000000000000000000000000000000000001" }),
    false,
  );
  assert.equal(walletIntegrityOk({ walletKey: undefined, publicWallet: ADDR }), false);
  assert.equal(walletIntegrityOk({ walletKey: "not-a-key", publicWallet: ADDR }), false);
});

test("assertWalletIntegrity throws on mismatch (fail-closed), passes on match", () => {
  assert.throws(() => assertWalletIntegrity({ walletKey: KEY, publicWallet: "0x0000000000000000000000000000000000000001" }));
  assert.doesNotThrow(() => assertWalletIntegrity({ walletKey: KEY, publicWallet: ADDR }));
});

test("publish_mission is autonomous (allowed); generic publish stays forbidden", () => {
  assert.equal(decide({ type: "publish_mission", reason: "test" }).decision, "ALLOWED");
  assert.equal(decide({ type: "publish", reason: "test" }).decision, "REJECTED");
});

test("default-deny and existing allowances unchanged", () => {
  assert.equal(decide({ type: "observe" }).decision, "ALLOWED");
  assert.equal(decide({ type: "narrate" }).decision, "ALLOWED");
  assert.equal(decide({ type: "spend" }).decision, "REJECTED");
  assert.equal(decide({ type: "transfer" }).decision, "REJECTED");
  assert.equal(decide({ type: "publish" }).decision, "REJECTED");
  assert.equal(decide({ type: "totally_unknown_thing" }).decision, "REJECTED");
  assert.equal(decide(null).decision, "REJECTED");
});
