// Holotype MIND worker entrypoint.
//
// Public surface is intentionally TINY: GET /healthz (liveness only) and
// GET /public/thoughts (disclosure-gated journal + public on-chain wallet read).
// Everything else — the creator's private channel, the darkroom log, and a manual beat
// trigger — is gated behind CREATOR_TOKEN. An unauthenticated request to a gated path
// gets a GENERIC 404 (not 403), so a public probe cannot even confirm the door exists.
//
// The cron handler runs one heartbeat; beat() carries its own kill-switch / disarmed /
// daily-budget guards, so a scheduled fire can never spend when disarmed.

import { asNum, readConfig, type Env, type RuntimeConfig } from "./config.js";
import { safeEqual, loadMasterKey } from "./crypto.js";
import { beat, readMarket, driveOf } from "./heartbeat.js";
import { COMMIT, COMMIT_SHORT, DEPLOYED_AT } from "./version.js";
import { toPublicEntries, secretValues } from "./disclose.js";
import { readUsdcBalances } from "./rpc.js";
import { walletIntegrityOk } from "./wallet.js";
import { consoleHtml } from "./console.js";
import { payApprovedMission, reconcileMission } from "./pay.js";
import {
  addPrivate,
  recentPrivate,
  rawPrivate,
  countPrivate,
  recentDarkroom,
  countDarkroom,
  spendTodayUsd,
  spendSummary,
  createMission,
  listMissions,
  getMission,
  setMissionStatus,
  setMissionClaim,
  setMissionDelivery,
  setMissionApproval,
  countMissionsSince,
  sumReservedTodayCents,
} from "./store.js";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const notFound = (): Response => json({ error: "not found" }, 404);

// Tolerant JSON field parse for stored JSON text columns; never throws on bad rows.
const safeJson = (s: string | null | undefined, fallback: any = null): any => {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

// Claim and submit-delivery move NO money, so they are open to counterparty agents
// without the creator token; completeness-check, approve, cancel and settlement stay
// creator-gated. Recipient (payout address) is supplied by the claimant at delivery and
// is what the batch-3 payment rail will lock into the approval record.
async function claimOrDelivery(env: Env, id: number, action: "claim" | "delivery", body: any): Promise<Response> {
  const m = await getMission(env.DB, id);
  if (!m) return notFound();
  if (action === "claim") {
    const claimant = String(body?.claimant ?? "").trim();
    if (!claimant) return json({ error: "claimant required" }, 400);
    if (m.status !== "open") return json({ error: `mission not open (status=${m.status})` }, 409);
    await setMissionClaim(env.DB, id, claimant);
    return json({ ok: true, id, status: "claimed" });
  }
  const summary = String(body?.summary ?? "").trim();
  const artifact = String(body?.artifact ?? "").trim();
  const recipient = String(body?.recipient ?? "").trim();
  const evidence = Array.isArray(body?.evidence) ? body.evidence.map((e: unknown) => String(e).trim()) : [];
  const criteria = safeJson(m.criteria, []);
  if (!summary || !artifact || !recipient || evidence.length !== criteria.length) {
    return json({ error: "summary, artifact, recipient and one evidence entry per criterion required" }, 400);
  }
  if (!["claimed", "changes_requested"].includes(m.status)) {
    return json({ error: `cannot deliver (status=${m.status})` }, 409);
  }
  await setMissionDelivery(
    env.DB,
    id,
    JSON.stringify({
      summary,
      artifact,
      recipient,
      evidence,
      taskHash: String(body?.taskHash ?? ""),
      submittedAt: new Date().toISOString(),
    }),
  );
  // Auto-run the completeness check at delivery: the fields were just validated above,
  // so a well-formed delivery goes straight to approval_pending (awaiting creator
  // approval). The manual /check endpoint remains for re-validation of older rows.
  await setMissionStatus(env.DB, id, "approval_pending");
  return json({ ok: true, id, status: "approval_pending" });
}

function tokenOf(req: Request): string {
  const h = req.headers.get("x-admin-token");
  if (h) return h.trim();
  const auth = req.headers.get("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function authed(req: Request, creatorToken: string | undefined): boolean {
  if (!creatorToken) return false; // no token configured => nothing is reachable
  const tok = tokenOf(req);
  return !!tok && safeEqual(tok, creatorToken);
}

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// Literal secret values the disclosure gate must never let out, even when the model
// echoes one verbatim. Covers non-hex secrets (creator token, RPC key) that the
// key-shape check cannot catch. RPC endpoints contribute both the full URL and the
// bare trailing token (e.g. the provider key segment) so a partial echo is caught too.
// (secretValues now lives in disclose.ts so all public surfaces share one source.)

async function handleFetch(req: Request, env: Env): Promise<Response> {
  const cfg = readConfig(env);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  // ---- public surface: liveness only ----
  // Minimal "I am alive" signal. Operational read-outs (model, spend, row counts,
  // arming flags) live behind the creator token at /creator/health, so the public
  // response carries nothing beyond the fact that the worker answers.
  if (path === "/healthz" && method === "GET") {
    return json({ ok: true, worker: "holotype-mind" });
  }

  // ---- public surface: build provenance ----
  // Lets anyone verify the running worker matches a specific source commit:
  // curl this, then check out `commit` in the public repository and compare.
  // Carries no operational or personal data — only the build stamp.
  if (path === "/version" && method === "GET") {
    return json({
      worker: "holotype-mind",
      commit: COMMIT,
      commit_short: COMMIT_SHORT,
      deployed_at: DEPLOYED_AT,
      repository: "https://github.com/ArcHolotype/holotype-mind",
    });
  }

  // ---- public surface: the disclosed life-sign ----
  // Journal rows pass the disclosure gate (fail-closed: a tripping row is dropped
  // whole). Wallet balances are on-chain reads of the public address only. The brain
  // flag mirrors the heartbeat kill switch, so the site badge cannot claim online
  // while beats are off.
  if (path === "/public/thoughts" && method === "GET") {
    const wanted = Math.min(50, Math.max(1, Math.floor(asNum(url.searchParams.get("n") ?? undefined, 12))));
    const rows = await recentDarkroom(env.DB, Math.min(200, wanted * 4));
    const entries = toPublicEntries(rows, cfg.publicWallet, secretValues(cfg), wanted);
    const balances = await readUsdcBalances({
      baseRpcUrls: cfg.baseRpcUrls,
      arcRpcUrls: cfg.arcRpcUrls,
      wallet: cfg.publicWallet,
      arcNativeDecimals: cfg.arcNativeDecimals,
    });
    const spend = await spendSummary(env.DB);
    const day = new Date().toISOString().slice(0, 10);
    const spentToday = await spendTodayUsd(env.DB, day);
    const remainingToday = Math.max(0, cfg.dailyBudgetUsd - spentToday);
    // Best-effort body read for the site's market-temperature bar and the Colony's
    // read-only neural layer; nulls on any failure so the endpoint still answers
    // and the site shows its fallback state.
    const market = await readMarket(env, cfg.bodyWorkerUrl);
    return json({
      worker: "holotype-mind",
      generated_at: new Date().toISOString(),
      brain: { online: cfg.heartbeatEnabled },
      wallet: { address: cfg.publicWallet, base_usdc: balances.baseUsdc, arc_usdc: balances.arcUsdc },
      spend: { total_usd: spend.total_usd, beats: spend.beats },
      budget: {
        cap_usd: cfg.dailyBudgetUsd,
        spent_today_usd: spentToday,
        remaining_today_usd: remainingToday,
      },
      market: {
        temperature: market.temperature,
        regime: market.regime,
        volume_usd: market.volumeUsd,
        trades: market.trades,
        source: market.source,
      },
      // The body's live collective neural snapshot (read-only) and this beat's coarse
      // drive, so the Colony can be modulated by real signals without new requests.
      body: market.neural,
      drive: driveOf(rows[0]?.intent_json ?? null),
      entries,
    });
  }

  // ---- public Nectar mission board (read-only, sanitized) ----
  // Shows Holo's real published needs and their live status. No approval/delivery
  // internals, no recipient addresses: those stay behind the creator token. Writes are
  // never public — the public site has no login and must not hold the creator token.
  if (path === "/missions" && method === "GET") {
    const rows = await listMissions(env.DB, { limit: 100 });
    const missions = rows
      .filter((m) => m.status !== "cancelled")
      .map((m) => ({
        id: m.id,
        ts: m.ts,
        title: m.title,
        description: m.description,
        criteria: safeJson(m.criteria, []),
        reward_usd: m.reward_cents / 100,
        chain: m.chain,
        status: m.status,
        updated_at: m.updated_at,
        tx_hash: m.tx_hash,
      }));
    return json({ worker: "holotype-mind", missions });
  }

  // Public settlement evidence pack: the verifiable chain "an agent claimed -> delivered
  // -> creator approved -> Holo settled on-chain". Recipient is only exposed once settled
  // (it is public on-chain at that point); pre-settlement it stays private.
  const evidenceMatch = path.match(/^\/missions\/(\d+)\/evidence$/);
  if (evidenceMatch && method === "GET") {
    const m = await getMission(env.DB, Number(evidenceMatch[1]));
    if (!m) return notFound();
    const delivery = safeJson(m.delivery);
    const approval = safeJson(m.approval);
    return json({
      worker: "holotype-mind",
      mission: {
        id: m.id,
        title: m.title,
        description: m.description,
        criteria: safeJson(m.criteria, []),
        reward_usd: m.reward_cents / 100,
        chain: m.chain,
        status: m.status,
        ts: m.ts,
        updated_at: m.updated_at,
      },
      claim: m.claimant ? { claimant: m.claimant } : null,
      delivery: delivery
        ? {
            summary: delivery.summary,
            artifact: delivery.artifact,
            taskHash: delivery.taskHash || null,
            submittedAt: delivery.submittedAt,
            evidence: delivery.evidence,
          }
        : null,
      approval: approval
        ? { by: approval.by, at: approval.at, amountCents: approval.amountCents, nonce: approval.nonce }
        : null,
      settlement: m.tx_hash
        ? { tx_hash: m.tx_hash, chain: m.chain, recipient: delivery?.recipient ?? null }
        : null,
    });
  }

  // Counterparty-agent actions (no money moves): claim and submit-delivery are open
  // without the creator token so an external agent can work a mission; completeness
  // check, approve, cancel and settlement remain creator-gated below.
  const publicMissionAction = path.match(/^\/missions\/(\d+)\/(claim|delivery)$/);
  if (publicMissionAction && method === "POST") {
    return claimOrDelivery(
      env,
      Number(publicMissionAction[1]),
      publicMissionAction[2] as "claim" | "delivery",
      await readBody(req),
    );
  }

  // ---- everything below requires the creator token; failures look like 404 ----
  const gated =
    path.startsWith("/creator") || path.startsWith("/darkroom") || path === "/beat";
  if (!gated) return notFound();
  // Private creator console shell: an unauthenticated login form + empty console that
  // reveals no data. The creator enters their token here (kept in this browser's session
  // storage); every data/action call then hits the gated JSON endpoints below, same-origin.
  if (path === "/creator/console" && method === "GET") {
    return new Response(consoleHtml(), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (!authed(req, cfg.creatorToken)) return notFound();

  // GET /creator/health — full operational diagnostics (token-gated, private):
  // the read-outs the public /healthz no longer carries. "armed" reports capability
  // WITHOUT revealing any secret material; spend/counts are for the creator only.
  if (path === "/creator/health" && method === "GET") {
    const day = new Date().toISOString().slice(0, 10);
    return json({
      ok: true,
      worker: "holotype-mind",
      heartbeatEnabled: cfg.heartbeatEnabled,
      model: cfg.model,
      // Does the armed key actually control the configured public wallet? The payment
      // rail refuses to arm when this is false (see wallet.ts); surfaced here so the
      // creator can see a mis-set key before any money path is enabled.
      walletIntegrity: walletIntegrityOk(cfg),
      bodyWorkerUrl: cfg.bodyWorkerUrl, // non-secret (already public in wrangler.toml); shown to diagnose routing
      armed: {
        wallet: !!cfg.walletKey,
        masterKey: !!cfg.masterKeyHex,
        creatorToken: !!cfg.creatorToken,
      },
      darkroomRows: await countDarkroom(env.DB).catch(() => null),
      privateRows: await countPrivate(env.DB).catch(() => null),
      spentTodayUsd: Number((await spendTodayUsd(env.DB, day).catch(() => 0)).toFixed(6)),
      dailyBudgetUsd: cfg.dailyBudgetUsd,
    });
  }

  // POST /creator/message {text} — store an encrypted private message from the creator.
  if (path === "/creator/message" && method === "POST") {
    if (!cfg.masterKeyHex) return json({ error: "master key not configured" }, 503);
    const body = await readBody(req);
    const text = String(body?.text ?? "").trim();
    if (!text) return json({ error: "missing text" }, 400);
    const key = await loadMasterKey(cfg.masterKeyHex);
    const id = await addPrivate(env.DB, key, "creator", text);
    return json({ ok: true, id, total: await countPrivate(env.DB) });
  }

  // GET /creator/messages?n= — decrypt + return recent private messages (creator-only).
  if (path === "/creator/messages" && method === "GET") {
    if (!cfg.masterKeyHex) return json({ error: "master key not configured" }, 503);
    const n = Math.min(100, Math.max(1, Number(url.searchParams.get("n") ?? "20")));
    const key = await loadMasterKey(cfg.masterKeyHex);
    const rows = await recentPrivate(env.DB, key, n);
    return json({ total: await countPrivate(env.DB), messages: rows });
  }

  // GET /creator/raw?n= — ciphertext only; proves the DB stores no plaintext.
  if (path === "/creator/raw" && method === "GET") {
    const n = Math.min(100, Math.max(1, Number(url.searchParams.get("n") ?? "5")));
    return json({ rows: await rawPrivate(env.DB, n) });
  }

  // GET /darkroom/recent?n= — Holo's inner log (narration/intent/verdict/cost).
  if (path === "/darkroom/recent" && method === "GET") {
    const n = Math.min(200, Math.max(1, Number(url.searchParams.get("n") ?? "10")));
    return json({ total: await countDarkroom(env.DB), rows: await recentDarkroom(env.DB, n) });
  }

  // POST /beat — run one heartbeat now (token-gated; still subject to all spend guards).
  // Optional ?model=<blockrun-id> overrides the default model for THIS beat only
  // (creator-only experiment; the cron always uses the configured default). Still
  // bounded by the per-beat cap + daily budget, so an override cannot overspend.
  if (path === "/beat" && method === "POST") {
    const modelOverride = url.searchParams.get("model") ?? undefined;
    const r = await beat(env, modelOverride);
    return json(r);
  }

  // ---- Nectar mission rails (creator-token gated; NO money moves here) ----
  // approve stops at "approved, unpaid": settlement is the batch-3 payment rail, which
  // additionally requires its own fresh per-tx approval before any transfer is signed.
  if (path === "/creator/missions" && method === "POST") {
    const body = await readBody(req);
    const title = String(body?.title ?? "").trim();
    const description = String(body?.description ?? "").trim();
    const criteria = Array.isArray(body?.criteria)
      ? body.criteria.map((c: unknown) => String(c).trim()).filter(Boolean)
      : [];
    const rewardCents = Math.floor(Number(body?.rewardCents ?? 0));
    const chain = String(body?.chain ?? "arc").trim() || "arc";
    if (!title || !description || criteria.length === 0 || rewardCents <= 0) {
      return json({ error: "title, description, non-empty criteria and rewardCents > 0 required" }, 400);
    }
    // Code-enforced caps, counted from the DB (never trusted from the caller):
    // 3 missions/24h, and the unified $30/24h across today's LLM spend + reserved rewards.
    const day = new Date().toISOString().slice(0, 10);
    const [spentToday, missionsToday, reservedTodayCents] = await Promise.all([
      spendTodayUsd(env.DB, day),
      countMissionsSince(env.DB, day),
      sumReservedTodayCents(env.DB, day),
    ]);
    if (missionsToday >= cfg.nectarMaxPerDay) {
      return json({ error: `mission cap reached (${cfg.nectarMaxPerDay} per 24h)` }, 429);
    }
    const projectedUsd = spentToday + (reservedTodayCents + rewardCents) / 100;
    if (projectedUsd > cfg.dailyBudgetUsd) {
      return json({ error: `daily cap would be exceeded ($${projectedUsd.toFixed(2)} > $${cfg.dailyBudgetUsd})` }, 429);
    }
    const id = await createMission(env.DB, { title, description, criteria, rewardCents, chain });
    return json({ ok: true, id });
  }
  if (path === "/creator/missions" && method === "GET") {
    return json({ missions: await listMissions(env.DB, { limit: 100 }) });
  }
  const missionAction = path.match(/^\/creator\/missions\/(\d+)\/(claim|delivery|check|approve|cancel|pay|reconcile)$/);
  if (missionAction && method === "POST") {
    const id = Number(missionAction[1]);
    const action = missionAction[2];
    const m = await getMission(env.DB, id);
    if (!m) return notFound();
    const body = await readBody(req);

    if (action === "claim" || action === "delivery") {
      return claimOrDelivery(env, id, action, body);
    }
    if (action === "check") {
      if (m.status !== "submitted") return json({ error: `nothing to check (status=${m.status})` }, 409);
      const d = safeJson(m.delivery);
      const criteria = safeJson(m.criteria, []);
      const complete =
        !!d &&
        !!d.summary &&
        !!d.artifact &&
        !!d.recipient &&
        Array.isArray(d.evidence) &&
        d.evidence.length === criteria.length &&
        d.evidence.every((e: unknown) => String(e).trim());
      const status = complete ? "approval_pending" : "changes_requested";
      await setMissionStatus(env.DB, id, status);
      return json({ ok: true, id, status, complete });
    }
    if (action === "approve") {
      if (m.status !== "approval_pending") return json({ error: `not awaiting approval (status=${m.status})` }, 409);
      const d = safeJson(m.delivery);
      // The approval record locks the exact payment params; batch 3 refuses to sign any
      // transfer without a matching fresh record. No money moves here (tx_hash stays null).
      const approval = {
        by: "creator",
        at: new Date().toISOString(),
        missionId: id,
        amountCents: m.reward_cents,
        recipient: d?.recipient ?? null,
        nonce: crypto.randomUUID(),
      };
      await setMissionApproval(env.DB, id, JSON.stringify(approval));
      return json({ ok: true, id, status: "approved", unpaid: true, approval });
    }
    if (action === "pay") {
      // Real on-chain settlement. Gated behind the approval record + integrity + atomic
      // slot inside payApprovedMission; this call is the creator's explicit per-tx go.
      const r = await payApprovedMission(env, cfg, id);
      return json(r, r.ok ? 200 : 409);
    }
    if (action === "reconcile") {
      // Only meaningful for a mission parked in payment_uncertain; verifies on-chain
      // before recording a tx, or resets to approved only after a scan finds no payment.
      const r = await reconcileMission(env, cfg, id, {
        txHash: typeof body?.txHash === "string" ? body.txHash : undefined,
        reset: body?.reset === true,
      });
      return json(r, r.ok ? 200 : 409);
    }
    if (action === "cancel") {
      await setMissionStatus(env.DB, id, "cancelled");
      return json({ ok: true, id, status: "cancelled" });
    }
  }

  return notFound();
}

async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  // beat() is self-guarding; we just fire it and log a one-line, secret-free summary.
  ctx.waitUntil(
    beat(env)
      .then((r) => {
        if (r.status === "ok") {
          console.log(
            `beat ok id=${r.id}/${r.total} ${r.model} ${r.verdict?.decision} cost=$${(r.costUsd ?? 0).toFixed(5)}`,
          );
        } else {
          console.log(`beat skipped: ${r.reason}`);
        }
      })
      .catch((e: any) => console.error(`beat error: ${e?.message ?? e}`)),
  );
}

export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
};
