// DexScreener client tests — pin the aggregation and the fail-safe empty read, using an injected
// fetcher so the suite never touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchTokenVolume, type DexFetch, type DexVolume } from "./dex.js";

const CA = "0xECa7C682fbb32EC4F1B3bBb28791Fe184D3552A8";

// A fetcher that returns a canned body (or a chosen failure mode).
function fetcherOf(body: unknown, opts: { ok?: boolean; throw?: boolean } = {}): DexFetch {
  return async () => {
    if (opts.throw) throw new Error("network down");
    return {
      ok: opts.ok ?? true,
      json: async () => body as { pairs?: unknown[] },
    };
  };
}

const pair = (o: Record<string, unknown>) => o;

test("aggregates 24h volume and trades across the token's arc pairs, price from the deepest pool", async () => {
  const f = fetcherOf({
    pairs: [
      pair({
        chainId: "arc", pairAddress: "0xaaa", baseToken: { address: CA }, quoteToken: { address: "0xusdc" },
        priceUsd: "0.00002553", volume: { h24: 14530.31 }, txns: { h24: { buys: 40, sells: 10 } }, liquidity: { usd: 13438.74 },
      }),
      pair({
        chainId: "arc", pairAddress: "0xbbb", baseToken: { address: CA }, quoteToken: { address: "0xweth" },
        priceUsd: "0.00009", volume: { h24: 100 }, txns: { h24: { buys: 2, sells: 1 } }, liquidity: { usd: 5 },
      }),
    ],
  });
  const v: DexVolume = await fetchTokenVolume(CA, "arc", { fetcher: f });
  assert.equal(v.pairs, 2);
  assert.ok(Math.abs(v.volumeUsd - 14630.31) < 1e-6);
  assert.equal(v.trades, 53);
  // deepest-liquidity pair (0xaaa) sets price/liquidity
  assert.equal(v.priceUsd, 0.00002553);
  assert.ok(Math.abs(v.liquidityUsd - 13438.74) < 1e-6);
});

test("ignores pairs on other chains and pairs that do not contain the token", async () => {
  const f = fetcherOf({
    pairs: [
      pair({ chainId: "base", pairAddress: "0xccc", baseToken: { address: CA }, volume: { h24: 999 }, txns: { h24: { buys: 9, sells: 9 } }, liquidity: { usd: 999 } }),
      pair({ chainId: "arc", pairAddress: "0xddd", baseToken: { address: "0xother" }, quoteToken: { address: "0xanother" }, volume: { h24: 555 }, txns: { h24: { buys: 5, sells: 5 } }, liquidity: { usd: 555 } }),
      pair({ chainId: "arc", pairAddress: "0xeee", quoteToken: { address: CA }, volume: { h24: 50 }, txns: { h24: { buys: 1, sells: 0 } }, liquidity: { usd: 10 } }),
    ],
  });
  const v = await fetchTokenVolume(CA, "arc", { fetcher: f });
  // only the arc pair where CA is the QUOTE counts
  assert.equal(v.pairs, 1);
  assert.equal(v.volumeUsd, 50);
  assert.equal(v.trades, 1);
});

test("dedupes by pair address and is case-insensitive on the token address", async () => {
  const f = fetcherOf({
    pairs: [
      pair({ chainId: "arc", pairAddress: "0xAAA", baseToken: { address: CA.toLowerCase() }, volume: { h24: 10 }, txns: { h24: { buys: 1, sells: 1 } }, liquidity: { usd: 1 } }),
      pair({ chainId: "arc", pairAddress: "0xaaa", baseToken: { address: CA }, volume: { h24: 10 }, txns: { h24: { buys: 1, sells: 1 } }, liquidity: { usd: 1 } }),
    ],
  });
  const v = await fetchTokenVolume(CA, "arc", { fetcher: f });
  assert.equal(v.pairs, 1);
  assert.equal(v.volumeUsd, 10);
});

test("empty read on !ok, on throw, on no pairs, and on a malformed address", async () => {
  const zero = (v: DexVolume) => {
    assert.deepEqual(v, { volumeUsd: 0, trades: 0, priceUsd: 0, liquidityUsd: 0, pairs: 0 });
  };
  zero(await fetchTokenVolume(CA, "arc", { fetcher: fetcherOf({}, { ok: false }) }));
  zero(await fetchTokenVolume(CA, "arc", { fetcher: fetcherOf({}, { throw: true }) }));
  zero(await fetchTokenVolume(CA, "arc", { fetcher: fetcherOf({ pairs: [] }) }));
  zero(await fetchTokenVolume(CA, "arc", { fetcher: fetcherOf({ pairs: null }) }));
  // malformed address short-circuits before any fetch
  zero(await fetchTokenVolume("not-an-address", "arc", { fetcher: fetcherOf({ pairs: [] }) }));
});

test("missing numeric fields are treated as zero, not NaN", async () => {
  const f = fetcherOf({
    pairs: [ pair({ chainId: "arc", pairAddress: "0xfff", baseToken: { address: CA } }) ],
  });
  const v = await fetchTokenVolume(CA, "arc", { fetcher: f });
  assert.equal(v.pairs, 1);
  assert.equal(v.volumeUsd, 0);
  assert.equal(v.trades, 0);
  assert.equal(v.priceUsd, 0);
  assert.ok(Number.isFinite(v.volumeUsd) && Number.isFinite(v.trades));
});
