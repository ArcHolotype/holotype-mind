// Private creator console, served by the mind worker itself at /creator/console.
// The shell is an unauthenticated login form + empty console (reveals no data); every
// data/action call afterwards is same-origin against the token-gated JSON endpoints with
// the creator token held only in this browser's sessionStorage. No CORS and no
// public-site token proxy are needed, keeping the creator surface entirely on the
// already-gated mind worker.
export function consoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Holo · Creator Console</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#080c0d; color:#e7e7df; font:14px/1.6 Arial,Helvetica,sans-serif; }
  main { max-width:860px; margin:0 auto; padding:28px 20px 80px; }
  h1 { font:normal 26px/1.2 Georgia,serif; margin:0 0 4px; }
  .sub { color:#8ca094; font:11px monospace; letter-spacing:.08em; margin:0 0 22px; }
  .card { border:1px solid rgba(204,221,216,.14); border-radius:10px; padding:16px; margin:0 0 14px; }
  label { display:block; font:10px monospace; letter-spacing:.1em; color:#8ca094; margin:10px 0 4px; }
  input,textarea,select { width:100%; box-sizing:border-box; background:#0c1510; color:#e7e7df; border:1px solid rgba(204,221,216,.2); border-radius:6px; padding:9px 10px; font:13px Arial; }
  textarea { min-height:64px; resize:vertical; }
  button { cursor:pointer; background:rgba(216,168,78,.1); color:#e2c078; border:1px solid rgba(216,168,78,.4); border-radius:6px; padding:9px 14px; font:12px Arial; margin-top:12px; }
  button.ghost { background:transparent; color:#9aac9f; border-color:rgba(204,221,216,.25); }
  button.danger { background:transparent; color:#c97971; border-color:rgba(201,121,113,.4); }
  .row { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
  .status { font:10px monospace; letter-spacing:.08em; padding:3px 8px; border:1px solid rgba(204,221,216,.25); border-radius:999px; color:#9db3a6; }
  .status.pending { color:#e2c078; border-color:rgba(216,168,78,.5); }
  .params { background:#0c1510; border:1px solid rgba(216,168,78,.3); border-radius:6px; padding:10px 12px; margin:10px 0; font:12px/1.7 monospace; color:#d8c9a4; white-space:pre-wrap; word-break:break-all; }
  .muted { color:#75877c; font-size:12px; }
  .err { color:#c97971; font-size:12px; margin-top:8px; }
  .hide { display:none; }
</style>
</head>
<body>
<main>
  <h1>Holo · Creator Console</h1>
  <p class="sub">PRIVATE · NOT LINKED PUBLICLY · TOKEN STAYS ON THIS DEVICE</p>

  <div class="card" id="login">
    <label for="tok">CREATOR TOKEN</label>
    <input id="tok" type="password" autocomplete="off" placeholder="paste your creator token">
    <button id="unlock">Unlock</button>
    <p class="muted">The token is kept only in this browser tab's session storage and sent only to this worker. Close the tab to drop it.</p>
    <p class="err hide" id="loginErr"></p>
  </div>

  <div id="console" class="hide">
    <div class="card">
      <div class="row"><strong>Publish a mission</strong><span class="muted">caps: 3 / 24h and the unified $30 / 24h</span></div>
      <label for="mTitle">TITLE</label><input id="mTitle">
      <label for="mDesc">DESCRIPTION</label><textarea id="mDesc"></textarea>
      <label for="mCrit">CRITERIA (one per line)</label><textarea id="mCrit"></textarea>
      <label for="mReward">REWARD (USD)</label><input id="mReward" type="number" step="0.01" min="0.01" value="0.50">
      <label for="mChain">CHAIN</label><select id="mChain"><option value="arc">arc</option><option value="base">base</option></select>
      <button id="create">Publish mission</button>
      <p class="err hide" id="createErr"></p>
    </div>

    <div class="card">
      <div class="row"><strong>Missions</strong><button class="ghost" id="refresh">Refresh</button><button class="ghost" id="lock">Lock console</button></div>
      <div id="list"></div>
    </div>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
// Escape any server/agent/brain-supplied text before it touches innerHTML (stored-XSS guard).
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tok = () => sessionStorage.getItem("holoCreatorToken") || "";
const setTok = (v) => v ? sessionStorage.setItem("holoCreatorToken", v) : sessionStorage.removeItem("holoCreatorToken");
const show = (id, on) => $(id).classList.toggle("hide", !on);
const err = (id, msg) => { $(id).textContent = msg || ""; show(id, !!msg); };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", "x-admin-token": tok(), ...(opts.headers || {}) },
  });
  if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || ("http " + res.status)); }
  return res.json();
}

function money(cents) { return (cents / 100).toFixed(2); }

function render(missions) {
  const list = $("list");
  if (!missions.length) { list.innerHTML = '<p class="muted">No missions yet.</p>'; return; }
  list.innerHTML = "";
  for (const m of missions) {
    const card = document.createElement("div");
    card.className = "card";
    const delivery = m.delivery ? JSON.parse(m.delivery) : null;
    const pending = m.status === "approval_pending";
    const params = pending
      ? "chain: " + esc(m.chain) + "\\nrecipient (payTo): " + esc(delivery ? delivery.recipient : "?") + "\\namount: $" + money(m.reward_cents) + " USDC\\nmission: " + esc(m.id) + " · " + esc(m.title)
      : "";
    card.innerHTML =
      '<div class="row"><strong>' + esc(m.id) + " · " + esc(m.title) + '</strong><span class="status' + (pending ? " pending" : "") + '">' + esc(m.status) + "</span>" +
      '<span class="muted">$' + money(m.reward_cents) + " / " + esc(m.chain) + "</span></div>" +
      '<p class="muted">' + esc(m.description) + "</p>" +
      (pending ? '<div class="params">WILL BE LOCKED BY YOUR APPROVAL:\\n' + params + "</div>" : "") +
      (m.approval ? '<p class="muted">approval: ' + esc(String(m.approval).slice(0, 120)) + "…</p>" : "") +
      (m.tx_hash ? '<p class="muted">settled tx: ' + esc(m.tx_hash) + "</p>" : "");
    const actions = document.createElement("div");
    actions.className = "row";
    if (pending) {
      const approve = document.createElement("button");
      approve.textContent = "Approve (records payment params; pays nothing yet)";
      approve.onclick = async () => { try { await api("/creator/missions/" + m.id + "/approve", { method: "POST", body: "{}" }); load(); } catch (e) { alert(e.message); } };
      actions.appendChild(approve);
    }
    if (m.status === "submitted") {
      const check = document.createElement("button");
      check.className = "ghost";
      check.textContent = "Run completeness check";
      check.onclick = async () => { try { await api("/creator/missions/" + m.id + "/check", { method: "POST", body: "{}" }); load(); } catch (e) { alert(e.message); } };
      actions.appendChild(check);
    }
    if (m.status === "payment_uncertain") {
      const rec = document.createElement("button");
      rec.className = "ghost";
      rec.textContent = "Reconcile payment";
      rec.onclick = async () => {
        const tx = prompt("Tx hash seen on explorer (leave empty to scan + optionally reset):") || "";
        try {
          const r = await api("/creator/missions/" + m.id + "/reconcile", { method: "POST", body: JSON.stringify({ txHash: tx, reset: !tx && confirm("No matching on-chain payment found after scan; reset to approved (re-enable pay)?") }) });
          alert(r.ok ? (r.txHash ? "recorded: " + r.txHash : (r.reason || "reconciled")) : "refused: " + r.reason);
        } catch (e) { alert(e.message); }
        load();
      };
      actions.appendChild(rec);
    }
    if (m.status === "approved") {
      const pay = document.createElement("button");
      pay.textContent = "PAY NOW · real on-chain transfer · $" + money(m.reward_cents);
      pay.onclick = async () => {
        const recip = (JSON.parse(m.delivery || "{}").recipient) || "?";
        if (confirm("Send $" + money(m.reward_cents) + " on-chain (" + m.chain + ") to " + recip + "?\\nThis moves REAL money and cannot be undone.")) {
          try {
            const r = await api("/creator/missions/" + m.id + "/pay", { method: "POST", body: "{}" });
            alert(r.ok ? "settled: " + r.txHash : "refused: " + r.reason);
          } catch (e) { alert(e.message); }
          load();
        }
      };
      actions.appendChild(pay);
    }
    if (m.status !== "cancelled" && m.status !== "completed") {
      const cancel = document.createElement("button");
      cancel.className = "danger";
      cancel.textContent = "Cancel mission";
      cancel.onclick = async () => { if (confirm("Cancel mission " + m.id + "?")) { try { await api("/creator/missions/" + m.id + "/cancel", { method: "POST", body: "{}" }); load(); } catch (e) { alert(e.message); } } };
      actions.appendChild(cancel);
    }
    card.appendChild(actions);
    list.appendChild(card);
  }
}

async function load() {
  try {
    const data = await api("/creator/missions");
    show("login", false); show("console", true);
    render(data.missions || []);
  } catch (e) {
    setTok(""); show("login", true); show("console", false);
    err("loginErr", "Token rejected or console unreachable: " + e.message);
  }
}

$("unlock").onclick = () => { setTok($("tok").value.trim()); $("tok").value = ""; err("loginErr", ""); load(); };
$("lock").onclick = () => { setTok(""); show("login", true); show("console", false); };
$("refresh").onclick = load;
$("create").onclick = async () => {
  const criteria = $("mCrit").value.split("\\n").map((s) => s.trim()).filter(Boolean);
  const body = {
    title: $("mTitle").value.trim(),
    description: $("mDesc").value.trim(),
    criteria,
    rewardCents: Math.round(parseFloat($("mReward").value || "0") * 100),
    chain: $("mChain").value,
  };
  try {
    await api("/creator/missions", { method: "POST", body: JSON.stringify(body) });
    err("createErr", "");
    $("mTitle").value = ""; $("mDesc").value = ""; $("mCrit").value = "";
    load();
  } catch (e) { err("createErr", e.message); }
};

if (tok()) load();
</script>
</body>
</html>`;
}
