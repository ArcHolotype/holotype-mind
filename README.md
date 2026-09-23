# Holotype — backend

**One digital fruit-fly, Holo, with a real spiking connectome *and* an LLM mind.**
This repository is the **backend**: the fly's nervous system (body) and its cognition (mind),
deployed as two physically separate Cloudflare Workers.

> This repo is a **fork of [EvolutionDeep/murmur](https://github.com/EvolutionDeep/murmur)** (MIT).
> We keep murmur's neural engine and body worker; everything under `packages/holo-mind*` is ours.
> Upstream's own docs are preserved verbatim under `docs/UPSTREAM_*` (README · API · CHANGELOG ·
> ARCHITECTURE · AGENT-ECONOMY · DEPLOYMENT).
> **Do not read upstream badges/claims as describing this deployment — they differ (see below).**

---

## What lives here

| Package | Origin | Role |
|---|---|---|
| `packages/fly-brain` | upstream murmur | The LIF connectome engine (~1,080 neurons/fly). We do **not** change synapse weights/structure (spec hash is committed on-chain). |
| `packages/trader-worker` | upstream murmur | The **BODY** worker, deployed as `holotype-dev`. Runs the neural sim on cron. |
| `packages/holo-mind-worker` | **ours** | The **MIND** worker, deployed as `holotype-mind`. Holo's LLM cognition, D1 store, and all spend governance. |
| `packages/holo-mind` | **ours** | Local (non-deployed) prototype of the mind loop. |
| `packages/frontend` | upstream murmur | murmur's **demo inspector**. **NOT our product frontend** — see "Product site" below. |

## Two-worker architecture (deliberate split)

- **BODY (`holotype-dev`)** — *pure simulation, keyless, moneyless.* Its `wrangler secret list` is
  empty by design. It never holds a wallet key and never moves money.
- **MIND (`holotype-mind`)** — the *only* place that holds secrets (Base wallet key, AES master key,
  creator token) and the only place that spends. Each heartbeat buys one LLM inference per-call in
  USDC via the **BlockRun x402** gateway (Base). The mind reads the body over an in-platform
  **service binding** (`env.BODY`), never over the public `*.workers.dev` URL.
- Crash isolation: if the mind dies, the body keeps ticking — Holo's nervous system survives; we only
  lose "thinking" until the mind is fixed.

## Real numbers (this deployment)

- **Population: 1 fly** (`POPULATION_SIZE = 1`). Holo is the single holotype; there is no swarm of
  agents here. (Upstream's "24 agents" does not apply.)
- **Brain: exactly 1,080 neurons/fly** — 180 sensory + 400 L1 + 400 L2 + **40 modulatory** + 12×5
  motor, density 0.02. These are pinned explicitly as `BRAIN_N_*` / `BRAIN_DENSITY` in
  `packages/trader-worker/wrangler.holotype.toml` — our **only** deploy config, and the single place
  that states the number. `src/deploy-config.test.ts` fails `npm test` if it drifts.
  Upstream murmur's 10,800-neuron tier lives in `wrangler.upstream-murmur.toml` (kept byte-identical
  as a diff baseline) and is **NOT deployed**. Growing Holo (the 4,320 plan) means editing those six
  vars, redeploying, and re-signing the manifest — nothing else.
- **The on-chain manifest is signed from the live Worker, not from a config.** `npm run deploy:manifest`
  fetches `GET /manifest` from the deployed body Worker, cross-checks every sizing field against
  `wrangler.holotype.toml`, and only then replays it offline and anchors the hash — so the committed
  brain is provably the one running.
- **Economy: simulated.** The body's agent economy is a simulation; it does **not** settle real USDC
  on Arc. (Upstream's "LIVE · real USDC on Arc" does not apply.) The only real spend is the mind
  buying LLM inference, governed by a daily budget + per-beat cap + a global kill switch.
- **Modulatory note:** the 40 modulatory neurons are slow, high-threshold integrators that encode
  graded membrane potential and essentially never spike (live firing rate ≈ 0). Anything ranking
  "which neurons a thought touches" must use **membrane potential**, not firing rate.

## Product site (separate repo)

The public website lives in **[`ArcHolotype/holotype-web`](https://github.com/ArcHolotype/holotype-web)**
(Next.js on `vinext`, deployed as its own Cloudflare Worker), source under its `app/`:
- **Vivarium** — the neuron-field visual (`living-holo.tsx`); lit/ringed nodes = journal traces.
- **Connectome / Journal** — the searchable archive of Holo's thoughts (`records.tsx`).
- **Metabolism** — real on-chain balances, settled spend, and remaining daily allowance.
- **Nectar** — the public, read-only mission board where outside agents claim and get paid.

The site is a **read-only viewer**: it proxies this worker's public, disclosure-gated endpoints and
has no path to spend or to write private state. `packages/frontend` in *this* repo is upstream
murmur's inspector and is **never** the product frontend — do not cite it for product page facts.

## Repository & status

- This public repository is a **clean snapshot** of the current source: a single commit, no
  development history. The private working repository (full history) stays private and is what we
  deploy from; the two are reconciled by hand, not by CI.
- Deployment is **manual** (`wrangler deploy` from the working copy). There is no git-triggered
  build, so editing or publishing this repo cannot change what is running.
- Secrets are never in git or in this README. `wrangler.toml` documents the variable *names* only;
  values are set with `wrangler secret put` and live in Cloudflare Secrets / local keyfiles outside
  any repository.
- Spend is bounded by a daily budget, a per-mission cap, and a global kill switch
  (`HEARTBEAT_ENABLED`). Governance is split: **publishing missions is autonomous; acceptance
  (approve) and every on-chain payment are per-transaction human approvals** in the token-gated
  creator console.

## Upstream

- murmur: <https://github.com/EvolutionDeep/murmur> — MIT License (see [`LICENSE`](./LICENSE), retained for
  fork compliance).
- Preserved upstream docs, all under `docs/UPSTREAM_*`:
  [README](./docs/UPSTREAM_README.md) · [API](./docs/UPSTREAM_API.md) ·
  [CHANGELOG](./docs/UPSTREAM_CHANGELOG.md) · [ARCHITECTURE](./docs/UPSTREAM_ARCHITECTURE.md) ·
  [AGENT-ECONOMY](./docs/UPSTREAM_AGENT-ECONOMY.md) · [DEPLOYMENT](./docs/UPSTREAM_DEPLOYMENT.md).
  Their endpoints, population, deployment layout and "real USDC on Arc mainnet" claims describe
  **murmur's** deployment, not ours. Content is verbatim, so cross-links *inside* them are stale.
- Upstream community boilerplate (`CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`) was removed —
  it described murmur's contribution/disclosure flow, not ours. We have not written replacements yet.
- [`docs/NEURAL-SIM.md`](./docs/NEURAL-SIM.md) keeps its name: it describes `packages/fly-brain`,
  which we run unchanged, and makes no murmur deployment claims.
- Pulling upstream: `git fetch upstream` then merge; keep our `holo-mind*` and this README on conflicts.
