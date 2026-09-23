// Market-temperature tests for the token-volume source. Pins: the meter maps a token's
// volume/trade ratio against its own EWMA baseline to HOT/CALM/COLD exactly as it did for
// whole-chain activity; the learned baseline survives persistence; and the sampler reduces a
// DexScreener response to the two signals (breadth = 24h trades, value = 24h volume USD).
// Global fetch is stubbed so the suite never touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { MarketMeter, derivePulse, sampleTokenVolume, sampleMarket, type MarketSample } from "./market.js";
import type { RuntimeConfig } from "./config.js";

const CA = "0xECa7C682fbb32EC4F1B3bBb28791Fe184D3552A8";

const volSample = (trades: number, volumeUsd: number): MarketSample => ({
  source: "token-volume", breadth: trades, value: volumeUsd, sampled: 1, head: 0, fetchedAt: 0,
});

function cfgFor(o: Partial<RuntimeConfig>): RuntimeConfig {
  return { isTestnet: false, tokenAddress: CA, marketSource: "token-volume", dexscreenerUrl: null, ...o } as unknown as RuntimeConfig;
}

// Stub global fetch to return a canned DexScreener body.
function withFetch(body: unknown, run: () => Promise<void>): () => Promise<void> {
  return async () => {
    const orig = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => ({
      ok: true,
      json: async () => body,
    });
    try {
      await run();
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = orig;
    }
  };
}

test("cold start seeds the baseline and reads CALM (0.5)", () => {
  const m = new MarketMeter();
  const s = m.update(volSample(100, 1000));
  assert.ok(Math.abs(s.temperature - 0.5) < 1e-9);
  assert.equal(s.regime, "CALM");
});

test("volume above the learned baseline drives HOT; below drives COLD", () => {
  const m = new MarketMeter();
  m.update(volSample(100, 1000)); // seed
  const hot = m.update(volSample(400, 4000)); // 4x the seed
  assert.ok(hot.temperature > 0.66, `expected HOT, got ${hot.temperature}`);
  assert.equal(hot.regime, "HOT");

  const m2 = new MarketMeter();
  m2.update(volSample(1000, 10000)); // seed high
  const cold = m2.update(volSample(100, 1000)); // 10x below the seed
  assert.ok(cold.temperature < 0.33, `expected COLD, got ${cold.temperature}`);
  assert.equal(cold.regime, "COLD");
});

test("a dead-quiet baseline (0 volume) is treated as neutral, not a divide-by-zero", () => {
  const m = new MarketMeter();
  m.update(volSample(0, 0)); // seed zeros
  const s = m.update(volSample(0, 0));
  assert.ok(Number.isFinite(s.temperature));
  assert.equal(s.regime, "CALM");
});

test("learned baseline survives toJSON/fromJSON (persistence across crons/deploys)", () => {
  const m = new MarketMeter();
  m.update(volSample(100, 1000));
  m.update(volSample(150, 1500));
  const before = m.toJSON();
  const restored = MarketMeter.fromJSON(before);
  // Same next observation must yield the same temperature from the restored meter.
  const a = m.update(volSample(300, 3000));
  const b = restored.update(volSample(300, 3000));
  assert.ok(Math.abs(a.temperature - b.temperature) < 1e-9);
  assert.equal(a.regime, b.regime);
});

test("derivePulse maps temperature + the two ratios onto the sensory facets", () => {
  const m = new MarketMeter();
  m.update(volSample(100, 1000));
  const st = m.update(volSample(300, 3000));
  const pulse = derivePulse(st, 0.5);
  assert.ok(pulse.temperature >= 0 && pulse.temperature <= 1);
  assert.ok(pulse.momentum > 0, "heating since prevTemperature 0.5");
  assert.ok(pulse.richness > 0.5, "breadth above baseline");
  assert.ok(pulse.density > 0.5, "value above baseline");
});

test("sampleTokenVolume reduces the DexScreener response to breadth=trades, value=volumeUsd", async () => {
  const body = {
    pairs: [
      { chainId: "arc", pairAddress: "0xaaa", baseToken: { address: CA }, priceUsd: "0.0000255", volume: { h24: 14530.31 }, txns: { h24: { buys: 40, sells: 10 } }, liquidity: { usd: 13438 } },
      { chainId: "base", pairAddress: "0xbbb", baseToken: { address: CA }, volume: { h24: 999 }, txns: { h24: { buys: 9, sells: 9 } }, liquidity: { usd: 999 } },
    ],
  };
  await withFetch(body, async () => {
    const s = await sampleTokenVolume(cfgFor({}));
    assert.equal(s.source, "token-volume");
    assert.equal(s.sampled, 1, "only the arc pair counts");
    assert.equal(s.breadth, 50);
    assert.ok(Math.abs(s.value - 14530.31) < 1e-6);
  })();
});

test("switching source re-seeds the baseline instead of comparing across scales", () => {
  const m = new MarketMeter();
  const arc = (tx: number, gas: number): MarketSample => ({ source: "arc-activity", breadth: tx, value: gas, sampled: 16, head: 1, fetchedAt: 0 });
  // Prime on arc-activity: gas/block is huge relative to token trade counts.
  m.update(arc(20, 4_000_000));
  m.update(arc(22, 4_200_000));
  // Flip to token-volume. Without a re-seed, value 14000 vs baselineGas 4e6 would read COLD and
  // breadth 50 vs baselineTx 21 would read HOT — a garbage blend. A re-seed makes it CALM.
  const switched = m.update(volSample(50, 14000));
  assert.ok(Math.abs(switched.temperature - 0.5) < 1e-9, `expected re-seeded CALM, got ${switched.temperature}`);
  assert.equal(switched.regime, "CALM");
  // The next token sample now compares against the token baseline, not the arc one.
  const hotter = m.update(volSample(200, 56000));
  assert.ok(hotter.temperature > 0.5, "4x the re-seeded token baseline should read warm");
});

test("persisted source is restored so a redeploy keeps the correct baseline scale", () => {
  const m = new MarketMeter();
  m.update(volSample(100, 1000));
  const restored = MarketMeter.fromJSON(m.toJSON());
  assert.equal((restored.toJSON() as { source: string }).source, "token-volume");
});

test("sampleMarket uses the token path only when selected AND an address is set; empty read → sampled 0", async () => {
  await withFetch({ pairs: [] }, async () => {
    const empty = await sampleMarket(cfgFor({}));
    assert.equal(empty.source, "token-volume");
    assert.equal(empty.sampled, 0, "empty read must not fold zeros as if real");
  })();

  await withFetch({ pairs: [{ chainId: "arc", pairAddress: "0x1", baseToken: { address: CA }, volume: { h24: 5 }, txns: { h24: { buys: 1, sells: 0 } }, liquidity: { usd: 1 } }] }, async () => {
    // token-volume requested but no address configured → must NOT take the token path
    const s = await sampleTokenVolume(cfgFor({ tokenAddress: null }));
    assert.equal(s.sampled, 0, "no address → empty read, never a crash");
  })();
});
