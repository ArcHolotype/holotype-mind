// Wallet integrity: prove the armed private key controls the configured public address
// BEFORE any payment rail may arm. Deriving the address from the key (secp256k1 public
// point + keccak256) and comparing to PUBLIC_WALLET_ADDRESS means a mis-set or swapped
// key can never silently sign as someone else. viem is already in the dependency tree
// via @blockrun/llm; it is declared explicitly here because we import it directly.
import { privateKeyToAddress } from "viem/accounts";
import type { RuntimeConfig } from "./config.js";

type WalletCfg = Pick<RuntimeConfig, "walletKey" | "publicWallet">;

export function deriveWalletAddress(privateKey: string): string {
  return privateKeyToAddress(privateKey as `0x${string}`).toLowerCase();
}

// True only when the armed key derives to exactly the configured public wallet.
export function walletIntegrityOk(cfg: WalletCfg): boolean {
  if (!cfg.walletKey) return false;
  try {
    return deriveWalletAddress(cfg.walletKey) === cfg.publicWallet.toLowerCase();
  } catch {
    return false;
  }
}

// Fail-closed gate for the payment rail: refuse to arm unless key matches address.
export function assertWalletIntegrity(cfg: WalletCfg): void {
  if (!walletIntegrityOk(cfg)) {
    throw new Error(
      "wallet integrity check failed: derived address != PUBLIC_WALLET_ADDRESS; payment rail refused",
    );
  }
}
