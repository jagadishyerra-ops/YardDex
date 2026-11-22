// YardDex admin dashboard: budgets, usage and families. Only emails listed in ADMIN_EMAILS can use it;
// every read and change goes through the `admin` Cloud Function, which checks that on the server.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, connectAuthEmulator, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig, functionsRegion, useEmulators } from "./firebase-config.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb), fns = getFunctions(fb, functionsRegion);
if (useEmulators && ["localhost", "127.0.0.1"].includes(location.hostname)) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFunctionsEmulator(fns, "127.0.0.1", 5001);
}
const adminFn = httpsCallable(fns, "admin", { timeout: 60000 });

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = n => { n = Number(n) || 0; return n === 0 ? "$0" : n < 0.01 ? "$" + n.toFixed(4) : "$" + n.toFixed(2); };
const int = n => (Number(n) || 0).toLocaleString();
const fmtDay = d => new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });
const fmtTime = iso => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3200); }
const call = async (data) => (await adminFn(data)).data;

let D = null, famQuery = "";

function show(html) { $("#view").innerHTML = html; }
function signInView(msg) {
  $("#acts").hidden = true;
  show(`<div class="signin"><h2 style="margin:0">Admin sign-in</h2>
    <p class="muted" style="margin:0">Sign in with the Google account listed in the <code>ADMIN_EMAILS</code> GitHub secret.</p>
    ${msg ? `<p class="warn" style="margin:0">${esc(msg)}</p>` : ""}
    <button class="big" type="button" id="btnSignIn">Sign in with Google</button></div>`);
}

async function load() {
  show(`<div class="thinking">Loading usage…</div>`);
  try {
    const w = await call({ action: "whoami" });
    if (!w.admin) {
      $("#acts").hidden = false;
      return show(`<div class="empty"><b>${esc(auth.currentUser?.email)} isn’t an admin.</b>
        <span class="muted">${w.configured
          ? "Add this email to the ADMIN_EMAILS secret in GitHub (Settings → Secrets and variables → Actions), then re-run the deploy."
          : "No admins are set up yet. In GitHub, go to Settings → Secrets and variables → Actions, add a secret named ADMIN_EMAILS containing your Google email, then re-run the Deploy to Firebase workflow."}</span></div>`);
    }
    D = await call({ action: "overview" });
    $("#acts").hidden = false;
    render();
  } catch (e) {
    show(`<div class="empty"><b>Couldn’t load the dashboard.</b><span class="muted">${esc(e?.message || "Check your connection and try Refresh.")}</span></div>`);
  }
}

function render() {
  const s = D.settings, today = D.days[D.days.length - 1];
  const people = new Set(D.families.flatMap(f => f.members.map(m => m.uid))).size;
  const budget = s.monthlyBudgetUsd, spent = D.thisMonth.costUsd;
  const pct = budget > 0 ? Math.min(100, Math.round(100 * spent / budget)) : 0;
  const perPhoto = D.thisMonth.photos ? D.thisMonth.costUsd / D.thisMonth.photos : null;
  const banners = [
    s.paused && `<div class="banner bad">Photo naming is paused for everyone.</div>`,
    !s.signupsOpen && `<div class="banner warn">New families are closed. Invite links still work.</div>`,
    budget > 0 && spent >= budget && `<div class="banner bad">This month’s budget is used up. Photo naming is stopped until next month or until you raise the budget.</div>`,
    budget > 0 && spent < budget && pct >= 80 && `<div class="banner warn">${pct}% of this month’s budget is used.</div>`,
  ].filter(Boolean).join("");
  show(`${banners}
  <div class="kpis">
    <div class="kpi"><small>Photos today</small><b>${int(today.photos)}</b><span>of ${int(s.globalDailyLimit)} allowed</span></div>
    <div class="kpi"><small>Cost today</small><b>${usd(today.costUsd)}</b><span>${today.errors ? `<span class="err">${today.errors} failed</span>` : "no failures"}</span></div>
    <div class="kpi"><small>This month</small><b>${usd(spent)}</b><span>${budget > 0 ? `of ${usd(budget)} budget` : "no monthly cap"}</span>
      ${budget > 0 ? `<div class="bar" role="img" aria-label="${pct}% of budget used"><i class="${pct >= 80 ? "hot" : ""}" style="width:${pct}%"></i></div>` : ""}</div>
    <div class="kpi"><small>Photos this month</small><b>${int(D.thisMonth.photos)}</b><span>${perPhoto != null ? `${usd(perPhoto)} each on average` : "none yet"}</span></div>
    <div class="kpi"><small>Families</small><b>${int(D.families.length)}</b><span>${int(people)} ${people === 1 ? "person" : "people"}</span></div>
    <div class="kpi"><small>Last month</small><b>${usd(D.lastMonth.costUsd)}</b><span>${int(D.lastMonth.photos)} photos</span></div>
  </div>
  ${chartPanel()}
  ${settingsPanel()}
  ${familiesPanel()}
  ${logPanel()}`);
}

function chartPanel() {
  const max = Math.max(1, ...D.days.map(d => d.photos));
  return `<section class="panel"><h2>Photos per day</h2><p class="note">Last 30 days (UTC). Hover or tap a bar for the cost.</p>
  <div class="chart" id="chart"><span class="ymax">${int(max)}</span>
    <div class="bars">${D.days.map((d, i) => `<button type="button" data-i="${i}" class="${d.photos ? "" : "zero"}" aria-label="${fmtDay(d.day)}: ${d.photos} photos, ${usd(d.costUsd)}"><i style="height:${Math.round(100 * d.photos / max)}%"></i></button>`).join("")}</div>
    <div class="axis"><span>${fmtDay(D.days[0].day)}</span><span>${fmtDay(D.days[15].day)}</span><span>Today</span></div>
  </div>
  <details><summary>Show as a table</summary><div class="scroll"><table class="tbl">
    <thead><tr><th>Day</th><th class="n">Photos</th><th class="n">Failed</th><th class="n">Cost</th><th class="n">Tokens in / out</th></tr></thead>
    <tbody>${D.days.slice().reverse().map(d => `<tr><td>${fmtDay(d.day)}</td><td class="n">${int(d.photos)}</td><td class="n">${int(d.errors)}</td><td class="n">${usd(d.costUsd)}</td><td class="n">${int(d.inputTokens)} / ${int(d.outputTokens)}</td></tr>`).join("")}</tbody>
  </table></div></details></section>`;
}

function settingsPanel() {
  const s = D.settings;
  const est = id => { const [pi, po] = D.models.find(m => m.id === id).price; return (2300 * pi + 1500 * po) / 1e6; };
  return `<section class="panel"><h2>Budget and limits</h2>
  <p class="note">Changes apply within 30 seconds. No redeploy needed.</p>
  <form id="settingsForm" class="form" autocomplete="off">
    <div class="fld"><label for="s_model">Claude model</label>
      <select class="field" id="s_model" name="model">${D.models.map(m => `<option value="${m.id}" ${s.model === m.id ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
      <p class="note">About ${D.models.map(m => `${usd(est(m.id))} (${m.label.split(" ")[0]})`).join(", ")} per photo. Haiku is fine for common finds; Sonnet is better at rare birds and bugs.</p></div>
    <div class="fld"><label for="s_effort">Effort</label>
      <select class="field" id="s_effort" name="effort">${D.efforts.map(e => `<option value="${e}" ${s.effort === e ? "selected" : ""}>${e[0].toUpperCase() + e.slice(1)}</option>`).join("")}</select>
      <p class="note">Higher looks more carefully (better with small or distant animals) and costs a little more.</p></div>
    <div class="fld"><label for="s_budget">Monthly budget (US $)</label>
      <input class="field" id="s_budget" name="monthlyBudgetUsd" type="number" min="0" max="10000" step="0.01" value="${s.monthlyBudgetUsd}">
      <p class="note">Photo naming stops for the month when Claude costs reach this. 0 = no cap. Also set a limit at console.anthropic.com as a backstop.</p></div>
    <div class="fld"><label for="s_fam">Photos per family per day</label>
      <input class="field" id="s_fam" name="familyDailyLimit" type="number" min="0" max="1000" step="1" value="${s.familyDailyLimit}">
      <p class="note">Default for every family. You can override it per family below.</p></div>
    <div class="fld"><label for="s_glob">Photos per day, all families</label>
      <input class="field" id="s_glob" name="globalDailyLimit" type="number" min="0" max="100000" step="1" value="${s.globalDailyLimit}">
      <p class="note">Hard ceiling for the whole app each day.</p></div>
    <div class="fld"><label for="s_newfam">New families per person per day</label>
      <input class="field" id="s_newfam" name="maxNewFamiliesPerDay" type="number" min="0" max="50" step="1" value="${s.maxNewFamiliesPerDay}"></div>
    <div class="fld"><label for="s_members">Most people in one family</label>
      <input class="field" id="s_members" name="maxMembers" type="number" min="1" max="200" step="1" value="${s.maxMembers}"></div>
    <div class="fld"><span class="label">Switches</span>
      <label class="sw"><input type="checkbox" name="signupsOpen" ${s.signupsOpen ? "checked" : ""}> Allow new families to sign up</label>
      <label class="sw"><input type="checkbox" name="paused" ${s.paused ? "checked" : ""}> Pause photo naming for everyone</label>
      <p class="note">While paused, families can still save finds and name them themselves.</p></div>
  </form>
  <div class="formacts"><button class="big" type="button" id="btnSaveSettings">Save settings</button><span class="note" id="savedNote"></span></div>
  </section>`;
}

function familiesPanel() {
  const q = famQuery.trim().toLowerCase();
  const list = D.families.filter(f => !q || f.name.toLowerCase().includes(q) || f.members.some(m => `${m.name} ${m.email}`.toLowerCase().includes(q)));
  const def = D.settings.familyDailyLimit;
  return `<section class="panel"><h2>Families</h2>
  <p class="note">${int(D.families.length)} ${D.families.length === 1 ? "family" : "families"}, newest first. Leave a family’s limit blank to use the default (${def}/day).</p>
  <input class="field" id="famSearch" type="search" placeholder="Search families or people" value="${esc(famQuery)}" aria-label="Search families" style="margin-bottom:10px">
  <div class="fams">${list.map(f => {
    const lim = f.dailyLimit ?? def;
    return `<article class="fam ${f.blocked ? "blocked" : ""}">
      <h3>${esc(f.name)} ${f.blocked ? `<span class="pill bad">Blocked</span>` : ""} ${f.dailyLimit != null ? `<span class="pill">Own limit: ${f.dailyLimit}/day</span>` : ""}</h3>
      <div class="famstats"><span>Today <b>${int(f.today.photos)}/${int(lim)}</b></span><span>This month <b>${int(f.month.photos)}</b> photos, <b>${usd(f.month.costUsd)}</b></span><span>Finds <b>${f.finds == null ? "?" : int(f.finds)}</b></span><span>Since ${new Date(f.createdAt).toLocaleDateString()}</span></div>
      <div class="members">${f.members.map(m => `${esc(m.name || "Someone")}${m.owner ? " (creator)" : ""}${m.email ? ` · ${esc(m.email)}` : ""}`).join("<br>")}</div>
      <div class="famacts">
        <label for="lim_${esc(f.id)}">Photos/day</label>
        <input class="field" id="lim_${esc(f.id)}" type="number" min="0" max="1000" step="1" placeholder="${def}" value="${f.dailyLimit ?? ""}" aria-label="Daily photo limit for ${esc(f.name)}" data-limit="${esc(f.id)}">
        <button class="small" type="button" data-savelimit="${esc(f.id)}">Set limit</button>
        <button class="small ${f.blocked ? "" : "danger"}" type="button" data-block="${esc(f.id)}" data-on="${f.blocked ? "0" : "1"}">${f.blocked ? "Unblock" : "Block"}</button>
        <button class="small danger" type="button" data-delfam="${esc(f.id)}">Delete family</button>
      </div></article>`;
  }).join("") || `<p class="muted">${q ? "No families match." : "No families yet."}</p>`}</div></section>`;
}

function logPanel() {
  return `<section class="panel"><h2>Recent photo naming</h2><p class="note">The last ${D.log.length} attempts across all families.</p>
  ${D.log.length ? `<div class="scroll"><table class="tbl">
    <thead><tr><th>When</th><th>Family</th><th>Result</th><th>Model</th><th class="n">Tokens in / out</th><th class="n">Cost</th><th class="n">Time</th></tr></thead>
    <tbody>${D.log.map(r => `<tr><td>${fmtTime(r.at)}</td><td>${esc(r.family)}</td>
      <td>${r.ok ? `<span class="okc">✓</span> ${esc(r.name)}` : `<span class="err">✕</span> ${esc(r.error)}`}</td>
      <td>${esc(String(r.model || "").replace("claude-", ""))}</td><td class="n">${int(r.inputTokens)} / ${int(r.outputTokens)}</td>
      <td class="n">${usd(r.costUsd)}</td><td class="n">${r.ms ? (r.ms / 1000).toFixed(1) + "s" : ""}</td></tr>`).join("")}</tbody>
  </table></div>` : `<p class="muted">Nothing yet. Snap a photo in the app and it shows up here.</p>`}</section>`;
}

async function saveSettings(btn) {
  const form = $("#settingsForm"), fd = new FormData(form), s = D.settings, patch = {};
  for (const k of ["model", "effort"]) if (fd.get(k) !== s[k]) patch[k] = fd.get(k);
  for (const k of ["familyDailyLimit", "globalDailyLimit", "maxNewFamiliesPerDay", "maxMembers"]) { const v = Number(fd.get(k)); if (v !== s[k]) patch[k] = v; }
  const b = Number(fd.get("monthlyBudgetUsd")); if (b !== s.monthlyBudgetUsd) patch.monthlyBudgetUsd = b;
  for (const k of ["signupsOpen", "paused"]) { const v = form.elements[k].checked; if (v !== s[k]) patch[k] = v; }
  if (!Object.keys(patch).length) return toast("Nothing changed.");
  btn.disabled = true; btn.textContent = "Saving…";
  try { const r = await call({ action: "saveSettings", patch }); D.settings = r.settings; render(); toast("Settings saved"); }
  catch (e) { toast(e?.message || "Couldn’t save."); btn.disabled = false; btn.textContent = "Save settings"; }
}

document.addEventListener("click", async e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.id === "btnSignIn") {
    const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" });
    try { await signInWithPopup(auth, p); } catch (err) { if (err?.code === "auth/popup-blocked") signInWithRedirect(auth, p); else if (err?.code !== "auth/popup-closed-by-user") signInView("Sign-in didn’t work. Try again."); }
    return;
  }
  if (t.id === "btnSignOut") return signOut(auth);
  if (t.id === "btnRefresh") return load();
  if (t.id === "btnSaveSettings") return saveSettings(t);
  const fam = id => D.families.find(f => f.id === id);
  try {
    if (t.dataset.savelimit) {
      const v = $(`[data-limit="${CSS.escape(t.dataset.savelimit)}"]`).value.trim();
      t.disabled = true;
      await call({ action: "setFamily", fid: t.dataset.savelimit, dailyLimit: v === "" ? null : Number(v) });
      fam(t.dataset.savelimit).dailyLimit = v === "" ? null : Number(v); render(); toast("Limit saved");
    }
    if (t.dataset.block) {
      const on = t.dataset.on === "1", f = fam(t.dataset.block);
      if (on && !confirm(`Block ${f.name}? They keep their finds but can’t name new photos with Claude.`)) return;
      t.disabled = true;
      await call({ action: "setFamily", fid: f.id, blocked: on }); f.blocked = on; render(); toast(on ? "Family blocked" : "Family unblocked");
    }
    if (t.dataset.delfam) {
      const f = fam(t.dataset.delfam);
      const typed = prompt(`This permanently deletes ${f.name}, all ${f.finds ?? ""} finds and every photo. Members go back to the start screen.\n\nType the family name to confirm:`);
      if (typed == null) return;
      if (typed.trim() !== f.name) return toast("Name didn’t match. Nothing was deleted.");
      t.disabled = true; t.textContent = "Deleting…";
      await call({ action: "deleteFamily", fid: f.id }); D.families = D.families.filter(x => x.id !== f.id); render(); toast("Family deleted");
    }
  } catch (err) { t.disabled = false; toast(err?.message || "That didn’t work."); }
});
document.addEventListener("input", e => {
  if (e.target.id === "famSearch") {
    famQuery = e.target.value;
    const pos = e.target.selectionStart;
    const panel = e.target.closest("section"); panel.outerHTML = familiesPanel();
    const inp = $("#famSearch"); inp.focus(); try { inp.setSelectionRange(pos, pos); } catch {}
  }
});
// Chart tooltip (hover on desktop, tap on phones).
function tip(btn) {
  const chart = $("#chart"); if (!chart) return;
  chart.querySelector(".tt")?.remove();
  if (!btn) return;
  const d = D.days[Number(btn.dataset.i)], r = btn.getBoundingClientRect(), c = chart.getBoundingClientRect();
  const el = document.createElement("div"); el.className = "tt";
  el.textContent = `${fmtDay(d.day)}: ${int(d.photos)} photos · ${usd(d.costUsd)}${d.errors ? ` · ${d.errors} failed` : ""}`;
  el.style.left = Math.min(Math.max(r.left - c.left + r.width / 2, 80), c.width - 80) + "px";
  el.style.top = Math.max(0, r.top - c.top + r.height - (btn.querySelector("i").getBoundingClientRect().height) - 6) + "px";
  chart.appendChild(el);
}
document.addEventListener("pointerover", e => { const b = e.target.closest(".bars button"); if (b) tip(b); });
document.addEventListener("pointerout", e => { if (e.target.closest(".bars button") && !e.relatedTarget?.closest?.(".bars button")) tip(null); });
document.addEventListener("focusin", e => { const b = e.target.closest(".bars button"); if (b) tip(b); });

getRedirectResult(auth).catch(() => {});
onAuthStateChanged(auth, user => {
  if (!user) return signInView();
  $("#who").textContent = `Signed in as ${user.email}`;
  load();
});
