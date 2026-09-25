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
import { maybeCadencePost, broadcastPublish, broadcastSettlement, maybeIngestCorpus, requiredByPace, isBehindPace } from "./broadcast.js";
import { prepareX402Purchase, executeX402Purchase, getOrPrepareX402Purchase } from "./x402buy.js";
import { listX402Purchases, reconcileX402Purchase, getPurchaseByKey } from "./x402guard.js";
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
  setMissionTxHash,
  countMissionsSince,
  sumReservedTodayCents,
  recentXPosts,
  countXSelfSentToday,
  countXSentAllToday,
  getXSchedule,
  countCorpus,
  countCorpusByTopic,
  listCorpus,
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
  const x402Endpoint = String(body?.x402Endpoint ?? "").trim();
  const evidence = Array.isArray(body?.evidence) ? body.evidence.map((e: unknown) => String(e).trim()) : [];
  const criteria = safeJson(m.criteria, []);
  // The seller picks the payout rail by what it delivers: a wallet address -> a vanilla
  // on-chain transfer; an x402 resource endpoint -> Holo buys the resource via the x402
  // buyer rail (the seller's own facilitator settles). Exactly one is required.
  const rail = x402Endpoint ? "x402" : recipient ? "vanilla" : "";
  if (!summary || !artifact || !rail || evidence.length !== criteria.length) {
    return json({ error: "summary, artifact, one evidence entry per criterion, and EITHER recipient (wallet) OR x402Endpoint required" }, 400);
  }
  if (recipient && x402Endpoint) {
    return json({ error: "provide EITHER recipient (vanilla payout) OR x402Endpoint (x402 purchase), not both" }, 400);
  }
  if (rail === "x402" && !/^https?:\/\//i.test(x402Endpoint)) {
    return json({ error: "x402Endpoint must be a valid http(s) url" }, 400);
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
      x402Endpoint,
      rail,
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
    const isX402 = delivery?.rail === "x402";
    // For an x402 settlement the purchase row IS the verifiable proof: the on-chain tx, the
    // EIP-3009 nonce and payer, and the AuthorizationUsed event topic anyone can re-scan to
    // confirm the authorization was consumed on-chain (authorizer = Holo's wallet, nonce).
    const purchase = isX402 ? await getPurchaseByKey(env.DB, `mission-${m.id}`) : null;
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
            rail: delivery.rail ?? "vanilla",
          }
        : null,
      approval: approval
        ? { by: approval.by, at: approval.at, amountCents: approval.amountCents, nonce: approval.nonce, rail: approval.rail ?? "vanilla" }
        : null,
      settlement: m.tx_hash
        ? {
            tx_hash: m.tx_hash,
            chain: m.chain,
            method: isX402 ? "x402" : "transfer",
            recipient: isX402 ? (purchase?.pay_to ?? null) : (delivery?.recipient ?? null),
          }
        : null,
      // Present only for an x402 settlement: the buyer-side proof that this was an EIP-3009
      // x402 purchase (not a plain transfer), verifiable against the chain by anyone.
      x402: purchase
        ? {
            method: "x402",
            scheme: "exact",
            asset_transfer_method: "eip3009",
            network: purchase.network,
            asset: purchase.asset,
            payer: purchase.payer,
            pay_to: purchase.pay_to,
            amount_atomic: purchase.amount,
            amount_usd: Number(purchase.amount) / 1e6,
            nonce: purchase.nonce,
            tx_hash: purchase.tx_hash,
            status: purchase.status,
            // Re-scan this asset for AuthorizationUsed(authorizer=payer, nonce) to verify on-chain.
            authorization_used_topic: "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5",
            receipt: safeJson(purchase.receipt),
          }
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
    // ① publish broadcast (inert unless armed). Best-effort; never affects the response.
    await broadcastPublish(env, id);
    return json({ ok: true, id });
  }
  if (path === "/creator/missions" && method === "GET") {
    return json({ missions: await listMissions(env.DB, { limit: 100 }) });
  }
  const missionAction = path.match(/^\/creator\/missions\/(\d+)\/(claim|delivery|check|approve|cancel|pay|reconcile|x402-quote|x402-pay)$/);
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
        (!!d.recipient || !!d.x402Endpoint) &&
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
      if (d?.rail === "x402") {
        return json({ error: "x402 missions settle via PAY NOW (x402-quote -> x402-pay), not vanilla approve" }, 409);
      }
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
    if (action === "x402-quote") {
      // Creator opened the PAY NOW dialog: fetch the seller's live 402 terms and lock them into
      // a review card (purchaseKey = mission-<id>). Moves NO money and signs nothing. The amount
      // is bounded by the mission's agreed reward AND the x402 per-purchase cap.
      if (!["approval_pending", "approved"].includes(m.status)) {
        return json({ error: `not awaiting payment (status=${m.status})` }, 409);
      }
      const d = safeJson(m.delivery);
      if (d?.rail !== "x402" || !d?.x402Endpoint) {
        return json({ error: "this mission is not an x402 delivery (no x402Endpoint)" }, 409);
      }
      const r = await getOrPrepareX402Purchase(env, cfg, {
        url: String(d.x402Endpoint),
        purchaseKey: `mission-${id}`,
        maxAmountCents: m.reward_cents,
      });
      return json(r, r.ok ? 200 : 409);
    }
    if (action === "x402-pay") {
      // The creator's single PAY NOW for an x402 mission: sign the prepared authorization and
      // settle through the seller's facilitator. Real money. Gated behind wallet integrity, the
      // x402 caps, the EOA-only payee check, the approval param-lock and the atomic single-pay claim.
      if (!["approval_pending", "approved"].includes(m.status)) {
        return json({ error: `not awaiting payment (status=${m.status})` }, 409);
      }
      const d = safeJson(m.delivery);
      if (d?.rail !== "x402") return json({ error: "this mission is not an x402 delivery" }, 409);
      const purchaseKey = `mission-${id}`;
      const r = await executeX402Purchase(env, cfg, purchaseKey);
      if (r.ok && r.transaction) {
        // Record the creator approval + settle the mission with the x402 tx as its evidence.
        const row = await getPurchaseByKey(env.DB, purchaseKey);
        const approval = {
          by: "creator",
          at: new Date().toISOString(),
          missionId: id,
          rail: "x402",
          amountCents: Math.round((r.amountUsd ?? 0) * 100),
          purchaseKey,
          nonce: row?.nonce ?? null,
          payTo: row?.pay_to ?? null,
          network: row?.network ?? null,
        };
        await setMissionApproval(env.DB, id, JSON.stringify(approval));
        await setMissionTxHash(env.DB, id, r.transaction);
        // ② settlement broadcast (inert unless armed). Best-effort; never affects the response.
        await broadcastSettlement(env, id, r.transaction);
        return json({ ...r, id, status: "completed" }, 200);
      }
      // An ambiguous outcome (signed but settlement unconfirmed) parks the mission so it is never
      // blindly re-paid; reconcile reads the chain (AuthorizationUsed) before allowing a retry.
      if (r.status === "uncertain") {
        await setMissionStatus(env.DB, id, "payment_uncertain");
      }
      return json({ ...r, id }, 409);
    }
    if (action === "pay") {
      // Real on-chain settlement (vanilla rail). Gated behind the approval record + integrity +
      // atomic slot inside payApprovedMission; this call is the creator's explicit per-tx go.
      const r = await payApprovedMission(env, cfg, id);
      return json(r, r.ok ? 200 : 409);
    }
    if (action === "reconcile") {
      // Only meaningful for a mission parked in payment_uncertain. An x402 mission reconciles
      // through the purchase row (AuthorizationUsed scan); a vanilla mission through pay.ts.
      const d = safeJson(m.delivery);
      if (d?.rail === "x402") {
        const r = await reconcileX402Purchase(env.DB, cfg, `mission-${id}`);
        if (r.ok && r.settled && r.txHash) {
          await setMissionTxHash(env.DB, id, r.txHash);
          // ② settlement broadcast on reconcile-confirmed settlement (dedup guard prevents a
          // duplicate if it was already broadcast at pay time). Inert unless armed.
          await broadcastSettlement(env, id, r.txHash);
        }
        return json(r, r.ok ? 200 : 409);
      }
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

  // ---- x402 buyer rail (creator-token gated) ----
  // prepare builds the review card and moves NO money; pay is the creator's single PAY NOW
  // (approve + sign + settle). Both are bounded by the x402 per-purchase + daily caps, the
  // EOA-only payee check, the approval param-lock and the atomic single-pay claim.
  if (path === "/creator/x402/prepare" && method === "POST") {
    const body = await readBody(req);
    const url = String(body?.url ?? "").trim();
    const purchaseKey = String(body?.purchaseKey ?? "").trim() || `x402-${crypto.randomUUID()}`;
    const r = await prepareX402Purchase(env, cfg, {
      url,
      purchaseKey,
      method: String(body?.method ?? "").toUpperCase() === "POST" ? "POST" : "GET",
      body: body?.body,
    });
    return json(r, r.ok ? 200 : 409);
  }
  if (path === "/creator/x402/pay" && method === "POST") {
    const body = await readBody(req);
    const purchaseKey = String(body?.purchaseKey ?? "").trim();
    if (!purchaseKey) return json({ error: "purchaseKey required" }, 400);
    const r = await executeX402Purchase(env, cfg, purchaseKey);
    return json(r, r.ok ? 200 : 409);
  }
  if (path === "/creator/x402/purchases" && method === "GET") {
    return json({ purchases: await listX402Purchases(env.DB, 100) });
  }
  if (path === "/creator/x402/reconcile" && method === "POST") {
    const body = await readBody(req);
    const purchaseKey = String(body?.purchaseKey ?? "").trim();
    if (!purchaseKey) return json({ error: "purchaseKey required" }, 400);
    const r = await reconcileX402Purchase(env.DB, cfg, purchaseKey);
    return json(r, r.ok ? 200 : 409);
  }

  // ---- X self-broadcast ops (creator-gated) ----
  // POST /creator/x/broadcast — fire one cadence post now (still subject to every gate:
  // enabled + key + interval + daily cap + budget + content/identity/dedup). Used to launch
  // and verify the first post on demand instead of waiting for the next cron tick.
  if (path === "/creator/x/broadcast" && method === "POST") {
    const r = await maybeCadencePost(env);
    return json(r ?? { skipped: "inert" });
  }
  // GET /creator/x/posts?n= — the broadcast audit log (what Holo posted / what the gate dropped).
  if (path === "/creator/x/posts" && method === "GET") {
    const n = Math.min(100, Math.max(1, Number(url.searchParams.get("n") ?? "20")));
    return json({ posts: await recentXPosts(env.DB, n) });
  }

  // GET /creator/x/schedule — when the next self-post becomes eligible, and how today's counts
  // stand against the floor and both ceilings. Read-only.
  if (path === "/creator/x/schedule" && method === "GET") {
    const day = new Date().toISOString().slice(0, 10);
    const sched = await getXSchedule(env.DB);
    const selfSent = await countXSelfSentToday(env.DB, day);
    const sentAll = await countXSentAllToday(env.DB, day);
    return json({
      day,
      next_eligible_at: sched.next_eligible_at,
      last_gap_minutes: sched.last_gap_minutes,
      self_sent_today: selfSent,
      sent_all_today: sentAll,
      floor: cfg.xPostMinPerDay,
      required_by_now: requiredByPace(cfg.xPostMinPerDay, new Date()),
      behind_pace: isBehindPace(selfSent, cfg.xPostMinPerDay, new Date()),
      self_ceiling: cfg.xPostMaxPerDay,
      plan_ceiling: cfg.xGlobalMaxPerDay,
      corpus_rows: await countCorpus(env.DB),
    });
  }

  // ---- Corpus ops (creator-gated) ----
  // POST /creator/x/corpus/ingest — run one reading batch now. Same code path the slow cron
  // uses; each batch is bounded to a few topics so one invocation stays well inside the Worker
  // subrequest ceiling. Costs no money: the sources are keyless public science APIs.
  if (path === "/creator/x/corpus/ingest" && method === "POST") {
    const body = await readBody(req);
    const maxTopics = body?.maxTopics == null ? undefined : Number(body.maxTopics);
    const r = await maybeIngestCorpus(env, { maxTopics: Number.isFinite(maxTopics as number) ? maxTopics : undefined });
    return json(r);
  }
  // GET /creator/x/corpus?n=&topic= — what Holo is allowed to read. Inspectable on purpose.
  if (path === "/creator/x/corpus" && method === "GET") {
    const n = Math.min(200, Math.max(1, Number(url.searchParams.get("n") ?? "10")));
    const topic = url.searchParams.get("topic");
    return json({
      total: await countCorpus(env.DB),
      by_topic: await countCorpusByTopic(env.DB),
      items: await listCorpus(env.DB, n, topic),
    });
  }

  return notFound();
}

// The slow "reading" cron, kept separate from the 15-minute tick so posting never waits on the
// network. Must match the second entry in wrangler.toml [triggers].crons.
const INGEST_CRON = "23 3 * * *";

async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  // The daily corpus top-up. Bounded per run (a few topics = a handful of subrequests) so it
  // stays inside the free-tier limits, and best-effort: a dead science API only means fewer new
  // excerpts, never a missed post.
  if (event.cron === INGEST_CRON) {
    ctx.waitUntil(
      maybeIngestCorpus(env)
        .then((r) => console.log(`corpus ingest stored=${r.stored} rejected=${r.rejected} dup=${r.duplicate} total=${r.total}${r.skipped ? ` skipped=${r.skipped}` : ""}${r.errors.length ? ` errors=${r.errors.join(";")}` : ""}`))
        .catch((e: any) => console.error(`corpus ingest error: ${e?.message ?? e}`)),
    );
    return;
  }

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
  // X self-broadcast cadence (③). maybeCadencePost is self-guarding (enabled + key + caps +
  // budget + schedule) and runs its cheap pre-checks before any model call, so firing it every
  // tick costs nothing unless a post is actually due. Fully inert until the user arms it.
  ctx.waitUntil(
    maybeCadencePost(env)
      .then((r) => {
        if (r && "posted" in r && r.posted) console.log(`x broadcast posted id=${r.id ?? "?"}`);
        else if (r && "skipped" in r) console.log(`x broadcast skipped: ${r.skipped}`);
        else if (r && "reason" in r) console.log(`x broadcast ${r.status}: ${r.reason}`);
      })
      .catch((e: any) => console.error(`x broadcast error: ${e?.message ?? e}`)),
  );
}

export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
};
