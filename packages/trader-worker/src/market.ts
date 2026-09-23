// Market temperature from Arc whole-chain activity.
//
// The previous project read a single token's DEX price. This one has NO token, NO price and NO
// trading — instead it observes how BUSY the Arc chain is and turns that into a "market
// temperature" that stimulates the fly population:
//
//   · Sample the most recent N blocks (by NUMBER — Arc repeats timestamps, so time windows lie).
//   · Reduce them to two throughput signals: mean transactions/block and mean gasUsed/block.
//   · Compare against a slow EWMA baseline that learns the chain's recent "normal".
//   · Map the current/baseline ratio through a logistic curve to a temperature in (0,1):
//       ratio = 1 (in line with the norm)  → 0.5  → CALM
//       ratio > 1 (busier than the norm)   → →1   → HOT   (market enthusiastic, liquid)
//       ratio < 1 (quieter than the norm)  → →0   → COLD  (market cold, thin)
//
// The EWMA baseline auto-calibrates to whatever network we point at (testnet today, mainnet
// later), so HOT/COLD always mean "relative to this chain's recent regime" rather than a
// hard-coded throughput that would need retuning on every network.

import type { RuntimeConfig } from "./config.js";
import { clamp } from "./config.js";
import { publicClient } from "./chain.js";
import { fetchTokenVolume } from "./dex.js";
import type { MarketPulse } from "@fly/fly-brain";

export type Regime = "HOT" | "CALM" | "COLD";

/** Where a market sample came from. `arc-activity` = whole-chain throughput; `token-volume` = one
 *  token's DEX trading volume (see MARKET_SOURCE / TOKEN_ADDRESS in config). */
export type MarketSource = "arc-activity" | "token-volume";

/**
 * One market observation, reduced to two same-scale signals that the meter compares against their
 * own EWMA baselines. The names are source-neutral:
 *   · arc-activity → breadth = mean tx/block,      value = mean gasUsed/block
 *   · token-volume → breadth = 24h trade count,    value = 24h volume (USD)
 */
export interface MarketSample {
  source: MarketSource;
  breadth: number;      // signal 1 (how MANY things happened)
  value: number;        // signal 2 (how HEAVY / how much value)
  sampled: number;      // arc: blocks that contributed; token: pairs aggregated
  head: number;         // arc: highest block number; token: 0 (n/a)
  fetchedAt: number;    // wall-clock ms when the sample completed
}

/** A sample plus the temperature/regime the MarketMeter derived from it. */
export interface MarketState {
  sample: MarketSample;
  temperature: number;    // (0,1); 0.5 = in line with the learned baseline
  regime: Regime;
  baselineTx: number;     // EWMA baseline of sample.breadth after this update (legacy key name, persisted)
  baselineGas: number;    // EWMA baseline of sample.value after this update (legacy key name, persisted)
}

/**
 * Turns raw Arc activity samples into a self-calibrating temperature. Persisted inside the
 * Durable Object via toJSON/fromJSON so the learned baseline survives across crons and deploys.
 */
export class MarketMeter {
  private alpha: number;   // steady-state EWMA smoothing (small = slow = tracks the regime)
  private hotT: number;    // temperature >= hotT ⇒ HOT
  private coldT: number;   // temperature <= coldT ⇒ COLD
  private gain: number;    // logistic sharpness mapping the activity ratio → temperature
  private baselineTx = 0;
  private baselineGas = 0;
  private sampleCount = 0; // samples folded in so far (drives the cold-start adaptive alpha)
  private primed = false;
  private source: MarketSource | null = null; // baselines are scale-specific to one source

  constructor(alpha = 0.08, hotT = 0.66, coldT = 0.33, gain = 3.0) {
    this.alpha = clamp(alpha, 0.001, 1);
    this.hotT = hotT;
    this.coldT = coldT;
    this.gain = clamp(gain, 0.2, 20);
  }

  /** Fold a fresh activity sample in and return the derived temperature + regime. */
  update(s: MarketSample): MarketState {
    // The EWMA baselines are calibrated to one source's scale (arc tx/gas vs token trades/volume).
    // If the source changes — e.g. flipping MARKET_SOURCE on a live DO that persisted arc-activity
    // baselines — re-seed from this sample instead of comparing across incommensurable scales,
    // which would otherwise spike the temperature until the baseline re-converged.
    if (this.source !== s.source) {
      this.primed = false;
      this.sampleCount = 0;
      this.source = s.source;
    }
    this.sampleCount++;
    if (!this.primed) {
      // Cold start: seed the baseline with the first observation. With no history to deviate
      // from, the market is CALM by definition (temperature settles at 0.5 below).
      this.baselineTx = s.breadth;
      this.baselineGas = s.value;
      this.primed = true;
    }

    // Guard against a dead-quiet baseline (division by ~0): treat that signal as neutral.
    const txRatio = this.baselineTx > 1e-6 ? s.breadth / this.baselineTx : 1;
    const gasRatio = this.baselineGas > 1e-6 ? s.value / this.baselineGas : 1;
    // Weight breadth a little above heaviness: how MANY things happened matters more to "market
    // enthusiasm" than how large each was. (arc: tx vs gas; token: trade count vs volume.)
    const ratio = 0.6 * txRatio + 0.4 * gasRatio;
    const temperature = ratioToTemperature(ratio, this.gain);

    // Adaptive alpha: fast at cold start (1/n) so the first-sample seed can't bias the whole run,
    // decaying to the slow steady alpha so the baseline then tracks the REGIME, not the spike.
    const aEff = Math.max(this.alpha, 1 / this.sampleCount);
    this.baselineTx += aEff * (s.breadth - this.baselineTx);
    this.baselineGas += aEff * (s.value - this.baselineGas);

    const regime: Regime =
      temperature >= this.hotT ? "HOT" : temperature <= this.coldT ? "COLD" : "CALM";

    return {
      sample: s,
      temperature,
      regime,
      baselineTx: this.baselineTx,
      baselineGas: this.baselineGas,
    };
  }

  get isPrimed(): boolean {
    return this.primed;
  }

  toJSON() {
    return {
      alpha: this.alpha,
      hotT: this.hotT,
      coldT: this.coldT,
      gain: this.gain,
      baselineTx: this.baselineTx,
      baselineGas: this.baselineGas,
      sampleCount: this.sampleCount,
      primed: this.primed,
      source: this.source,
    };
  }

  static fromJSON(o: any): MarketMeter {
    const m = new MarketMeter(o?.alpha, o?.hotT ?? 0.66, o?.coldT ?? 0.33, o?.gain ?? 3.0);
    m.baselineTx = Number(o?.baselineTx ?? 0);
    m.baselineGas = Number(o?.baselineGas ?? 0);
    m.sampleCount = Number(o?.sampleCount ?? 0);
    m.primed = !!o?.primed;
    m.source = (o?.source as MarketSource | null) ?? null;
    return m;
  }
}

/** Logistic map centred at ratio = 1 (temperature 0.5 = CALM); k controls the sharpness.
 *  k ≈ 3 was chosen against live Arc testnet data (55k-block history): real ±30% activity
 *  swings then span the full CALM↔HOT/COLD range, whereas k = 1.6 huddled around 0.5 (all
 *  CALM) and k = 4 flipped regimes on noise. */
function ratioToTemperature(ratio: number, k = 3.0): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return 1 / (1 + Math.exp(-k * (ratio - 1)));
}

/**
 * Read the most recent `cfg.marketSampleBlocks` Arc blocks and reduce them to mean tx/block and
 * mean gasUsed/block. Blocks are fetched by NUMBER in parallel; individual failures are skipped
 * (sampleBlocks reports how many actually contributed) so one flaky RPC call can't zero a tick.
 */
export async function sampleArcActivity(cfg: RuntimeConfig): Promise<MarketSample> {
  const client = publicClient(cfg);
  const head = await client.getBlockNumber();
  const n = Math.max(1, cfg.marketSampleBlocks);

  const from = head - BigInt(n - 1);
  const nums: bigint[] = [];
  for (let i = 0; i < n; i++) nums.push(from + BigInt(i));

  const blocks = await Promise.all(
    nums.map((bn) => client.getBlock({ blockNumber: bn }).catch(() => null)),
  );

  let txSum = 0;
  let gasSum = 0;
  let count = 0;
  let maxBn = 0n;
  for (const b of blocks) {
    if (!b) continue;
    txSum += b.transactions?.length ?? 0;
    gasSum += Number(b.gasUsed ?? 0n);
    count++;
    if (b.number != null && b.number > maxBn) maxBn = b.number;
  }

  const denom = Math.max(1, count);
  return {
    source: "arc-activity",
    breadth: txSum / denom,
    value: gasSum / denom,
    sampled: count,
    head: Number(maxBn > 0n ? maxBn : head),
    fetchedAt: Date.now(),
  };
}

/**
 * Read one token's 24h DEX trading activity (DexScreener) and reduce it to the same two signals:
 * breadth = 24h trade count (buys + sells), value = 24h volume in USD, aggregated across every
 * pair for the token on the configured chain. An empty/unreachable read returns `sampled: 0` so the
 * caller can hold the previous temperature rather than snapping the organism to COLD on one bad
 * fetch.
 */
export async function sampleTokenVolume(cfg: RuntimeConfig): Promise<MarketSample> {
  const chainName = cfg.isTestnet ? "arc-testnet" : "arc";
  const v = await fetchTokenVolume(cfg.tokenAddress ?? "", chainName, {
    baseUrl: cfg.dexscreenerUrl ?? undefined,
  });
  return {
    source: "token-volume",
    breadth: v.trades,
    value: v.volumeUsd,
    sampled: v.pairs,
    head: 0,
    fetchedAt: Date.now(),
  };
}

/**
 * Choose the market data source. `token-volume` is used only when it is selected AND a token address
 * is configured; otherwise fall back to Arc whole-chain activity. Kept as a switch so the organism's
 * temperature driver can be flipped back without a code change.
 */
export async function sampleMarket(cfg: RuntimeConfig): Promise<MarketSample> {
  const wantToken = cfg.marketSource === "token-volume" && !!cfg.tokenAddress;
  return wantToken ? sampleTokenVolume(cfg) : sampleArcActivity(cfg);
}

/**
 * Bridge from the market temperature to the fly population's sensory pulse. The temperature is the
 * headline; the facets give the connectome extra texture so HOT / CALM / COLD feel qualitatively
 * different rather than just "more or less":
 *   · temperature → thermosensation (the collective anchor for every fly)
 *   · momentum    → heating (+) vs cooling (−) since the previous tick, amplified because the
 *                   per-tick delta is tiny (temperature moves slowly by design)
 *   · turbulence  → |temperature − 0.5| — how far the chain currently sits from its learned norm
 *   · density     → gas heaviness relative to the baseline (at norm ⇒ 0.5)
 *   · richness    → transaction breadth relative to the baseline (at norm ⇒ 0.5; a liquidity proxy)
 * The per-fly `arousal` facet is deliberately NOT set here — the Population injects each fly's own
 * temperament so individuals keep distinct internal tempos.
 */
export function derivePulse(state: MarketState, prevTemperature: number): MarketPulse {
  const T = state.temperature;
  const txRatio = state.baselineTx > 1e-6 ? state.sample.breadth / state.baselineTx : 1;
  const gasRatio = state.baselineGas > 1e-6 ? state.sample.value / state.baselineGas : 1;
  return {
    temperature: clamp01(T),
    momentum: clamp((T - prevTemperature) * 10, -1, 1),
    turbulence: clamp01(Math.abs(T - 0.5) * 2),
    density: clamp01(0.5 * gasRatio),
    richness: clamp01(0.5 * txRatio),
  };
}

const clamp01 = (x: number): number => clamp(x, 0, 1);
