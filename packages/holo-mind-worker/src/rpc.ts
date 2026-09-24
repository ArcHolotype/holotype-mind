// Minimal JSON-RPC reader for on-chain facts the public surface may show.
// Read-only by construction: this module exposes no signing or sending path.
// Balances are read for the configured PUBLIC wallet address only — public info by
// design (x402 spend evidence is a product feature). No private key touches this file.

export interface UsdcBalances {
  baseUsdc: number | null;
  arcUsdc: number | null;
}

// Canonical USDC contract on Base mainnet. On Arc, USDC is the native gas token, so the
// Arc side reads the native balance and scales by the configured native decimals; that
// decimal count has no on-chain decimals() to ask, so it stays a config value verified
// against an explorer at first funding (a zero balance reads zero under any decimals).
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BALANCE_OF_SELECTOR = "0x70a08231";
const DECIMALS_SELECTOR = "0x313ce567";

export async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const payload = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (payload.error) throw new Error(`rpc error: ${payload.error.message ?? "unknown"}`);
  return payload.result;
}

// A secret or var may carry several endpoints (space or comma separated) so one key can
// fall back to a spare. Order is priority: first healthy url wins, no round-robin —
// same-provider keys share the provider's fate, so spreading load buys nothing here.
export function parseRpcList(...sources: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const part of source.split(/[\s,]+/)) {
      const url = part.trim();
      if (url.startsWith("http") && !out.includes(url)) out.push(url);
    }
  }
  return out;
}

export function withRpcFallback<T>(urls: string[], fn: (url: string) => Promise<T>): Promise<T> {
  if (urls.length === 0) return Promise.reject(new Error("no rpc urls configured"));
  return urls.reduce(
    (chain, url) => chain.catch(() => fn(url)),
    Promise.reject<T>(new Error("rpc fallback start")),
  );
}

export function hexToUint(hex: unknown): bigint {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error("not a hex quantity");
  return BigInt(hex);
}

export function balanceOfData(address: string): string {
  return BALANCE_OF_SELECTOR + address.toLowerCase().replace("0x", "").padStart(64, "0");
}

function toUnits(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export async function readBaseUsdc(url: string, wallet: string): Promise<number> {
  const decimalsHex = await rpcCall(url, "eth_call", [{ to: BASE_USDC_ADDRESS, data: DECIMALS_SELECTOR }, "latest"]);
  const decimals = Number(hexToUint(decimalsHex));
  const balHex = await rpcCall(url, "eth_call", [{ to: BASE_USDC_ADDRESS, data: balanceOfData(wallet) }, "latest"]);
  return toUnits(hexToUint(balHex), decimals);
}

export async function readArcNativeUsdc(url: string, wallet: string, decimals: number): Promise<number> {
  const balHex = await rpcCall(url, "eth_getBalance", [wallet, "latest"]);
  return toUnits(hexToUint(balHex), decimals);
}

export async function readUsdcBalances(opts: {
  baseRpcUrls: string[];
  arcRpcUrls: string[];
  wallet: string;
  arcNativeDecimals: number;
}): Promise<UsdcBalances> {
  const [baseUsdc, arcUsdc] = await Promise.all([
    withRpcFallback(opts.baseRpcUrls, (url) => readBaseUsdc(url, opts.wallet)).catch(() => null),
    withRpcFallback(opts.arcRpcUrls, (url) => readArcNativeUsdc(url, opts.wallet, opts.arcNativeDecimals)).catch(() => null),
  ]);
  return { baseUsdc, arcUsdc };
}

// ---- x402 settlement evidence (read-only) ----
// ERC-20 Transfer(address,address,uint256) event topic, verified against live Base logs.
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface UsdcOutflow {
  txHash: string;
  valueUnits: number;
  blockNumber: number;
}

export async function readLatestBlock(url: string): Promise<number> {
  return Number(hexToUint(await rpcCall(url, "eth_blockNumber", [])));
}

// One 1000-block window (public RPCs cap getLogs ranges) of USDC Transfer events sent
// FROM the wallet — i.e. the x402 settlement outflows. Read-only, no signing.
export async function readUsdcOutflowWindow(
  url: string,
  wallet: string,
  fromBlock: number,
  toBlock: number,
): Promise<UsdcOutflow[]> {
  const topic1 = "0x" + wallet.toLowerCase().replace("0x", "").padStart(64, "0");
  const logs = (await rpcCall(url, "eth_getLogs", [
    {
      address: BASE_USDC_ADDRESS,
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      topics: [TRANSFER_TOPIC, topic1],
    },
  ])) as { transactionHash?: string; data?: string; blockNumber?: string }[];
  const out: UsdcOutflow[] = [];
  for (const l of logs ?? []) {
    if (!l?.transactionHash || !l?.data || l.data.length < 66 || !l?.blockNumber) continue;
    out.push({
      txHash: l.transactionHash,
      valueUnits: Number(hexToUint(l.data)) / 1e6,
      blockNumber: Number(hexToUint(l.blockNumber)),
    });
  }
  return out;
}

export async function readBlockTimestamp(url: string, blockNumber: number): Promise<number> {
  const blk = (await rpcCall(url, "eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false])) as {
    timestamp?: string;
  };
  return Number(hexToUint(blk?.timestamp ?? "0x0"));
}

// ---- payee safety: refuse to pay a contract (EOA-only) ----
// An externally-owned account (a normal wallet) has no deployed code, so eth_getCode returns
// "0x". A contract returns its bytecode. Sending value to a plain wallet is inert, but sending
// to a contract can run arbitrary receive/fallback logic, so BOTH payout rails (vanilla pay.ts
// and the x402 buyer rail) verify the destination is an EOA before any transfer is signed.
export async function isContractAddress(url: string, address: string): Promise<boolean> {
  const code = await rpcCall(url, "eth_getCode", [address, "latest"]);
  if (typeof code !== "string") throw new Error("eth_getCode returned a non-string");
  const body = code.replace(/^0x/, "");
  return body.length > 0 && body !== "0";
}

// Fail-closed: when the check cannot be completed (no urls configured, or every rpc errored)
// we treat the payee as unsafe and REFUSE, rather than pay an unverified destination. Money
// safety outweighs availability here — a transient rpc failure just means "retry later".
export async function assertPayeeIsWallet(
  urls: string[],
  address: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (urls.length === 0) {
    return { ok: false, reason: "no rpc urls configured to verify the payee is a wallet (EOA-only)" };
  }
  try {
    const isContract = await withRpcFallback(urls, (url) => isContractAddress(url, address));
    return isContract
      ? { ok: false, reason: `payee ${address} is a contract; refusing to pay (wallet/EOA only)` }
      : { ok: true };
  } catch (e) {
    return { ok: false, reason: `could not verify the payee is a wallet (EOA check failed): ${(e as Error).message}` };
  }
}
