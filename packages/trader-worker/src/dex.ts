// DexScreener client — reads a token's recent DEX activity so the market temperature can be
// driven by that token's trading volume instead of whole-chain activity.
//
// DexScreener's public token endpoint returns every indexed pair for an address across chains:
//   GET https://api.dexscreener.com/latest/dex/tokens/{address}
// We keep only the pairs on the configured chain whose base OR quote is the token, dedupe by
// pair address, and aggregate the 24h volume and trade count. Price/liquidity are taken from the
// deepest pair. The fetch is injectable so tests never hit the network.

export type DexVolume = {
  volumeUsd: number;   // summed 24h quote volume across the token's pairs on this chain
  trades: number;      // summed 24h buys + sells across those pairs
  priceUsd: number;    // price from the deepest-liquidity pair (0 if none)
  liquidityUsd: number;// deepest pair's liquidity (0 if none)
  pairs: number;       // how many pairs contributed
};

type DexPair = {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  liquidity?: { usd?: number };
};

export type DexFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  json: () => Promise<{ pairs?: DexPair[] | null }>;
}>;

const DEFAULT_URL = "https://api.dexscreener.com/latest/dex/tokens/";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Aggregate a token's 24h DEX volume on one chain. Returns zeroed counts (pairs: 0) when the
 * token has no indexed pair there or the API is unreachable — the caller decides how to treat an
 * empty read (the market meter holds its previous temperature rather than snapping to COLD).
 */
export async function fetchTokenVolume(
  tokenAddress: string,
  chainId: string,
  opts: { fetcher?: DexFetch; baseUrl?: string; timeoutMs?: number } = {},
): Promise<DexVolume> {
  const empty: DexVolume = { volumeUsd: 0, trades: 0, priceUsd: 0, liquidityUsd: 0, pairs: 0 };
  const ca = tokenAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/i.test(ca)) return empty;

  const fetcher = opts.fetcher ?? (fetch as unknown as DexFetch);
  const url = `${(opts.baseUrl ?? DEFAULT_URL).replace(/\/+$/, "")}/${tokenAddress}`;

  let pairs: DexPair[];
  try {
    const res = await fetcher(url, { headers: { accept: "application/json" } });
    if (!res.ok) return empty;
    const body = await res.json();
    pairs = Array.isArray(body?.pairs) ? body.pairs : [];
  } catch {
    return empty;
  }

  const wantChain = chainId.trim().toLowerCase();
  const seen = new Set<string>();
  let volumeUsd = 0;
  let trades = 0;
  let count = 0;
  let bestLiq = -1;
  let priceUsd = 0;
  let liquidityUsd = 0;

  for (const p of pairs) {
    if ((p.chainId ?? "").toLowerCase() !== wantChain) continue;
    const base = (p.baseToken?.address ?? "").toLowerCase();
    const quote = (p.quoteToken?.address ?? "").toLowerCase();
    if (base !== ca && quote !== ca) continue;
    const key = (p.pairAddress ?? `${base}:${quote}:${count}`).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    volumeUsd += num(p.volume?.h24);
    trades += num(p.txns?.h24?.buys) + num(p.txns?.h24?.sells);
    count++;

    const liq = num(p.liquidity?.usd);
    if (liq > bestLiq) {
      bestLiq = liq;
      liquidityUsd = liq;
      priceUsd = Number(p.priceUsd ?? 0) || 0;
    }
  }

  return { volumeUsd, trades, priceUsd, liquidityUsd, pairs: count };
}
