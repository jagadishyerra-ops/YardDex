const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString, defineInt } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const crypto = require("node:crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { buildPrompt, parseCard } = require("./prompt");
const { MODEL_CHOICES, EFFORTS, PRICES, costUsd, cleanSettings, mergeSettings, dayKey, monthKey } = require("./settings");

initializeApp();
const db = () => getFirestore();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
// These .env values are only the starting defaults. Once you save settings in the admin dashboard
// (/admin), the values stored in Firestore config/settings win, with no redeploy needed.
// Any current vision-capable Claude model works. If this one is retired, the function falls back to the newest Haiku.
const CLAUDE_MODEL = defineString("CLAUDE_MODEL", { default: "claude-haiku-5-5" });
// Photos one family can identify per day.
const DAILY_LIMIT = defineInt("DAILY_LIMIT", { default: 60 });
// Photos the whole app can identify per day, across every family. Protects your Claude API bill.
const GLOBAL_DAILY_LIMIT = defineInt("GLOBAL_DAILY_LIMIT", { default: 300 });
// Who may open /admin: Google emails separated by commas. Set from the ADMIN_EMAILS GitHub secret at deploy time.
const ADMIN_EMAILS = defineString("ADMIN_EMAILS", { default: "" });

const envDefaults = () => ({
  model: CLAUDE_MODEL.value(),
  effort: "high",
  familyDailyLimit: DAILY_LIMIT.value(),
  globalDailyLimit: GLOBAL_DAILY_LIMIT.value(),
  monthlyBudgetUsd: 10,        // 0 = no monthly cap
  maxNewFamiliesPerDay: 3,     // per person; stops someone making endless families to dodge the family limit
  maxMembers: 30,
  signupsOpen: true,           // off = nobody can create new families (invite links still work)
  paused: false,               // on = photo identification is switched off for everyone
});
let settingsCache = { at: 0, val: null };
async function getSettings(fresh) {
  if (!fresh && settingsCache.val && Date.now() - settingsCache.at < 30000) return settingsCache.val;
  const snap = await db().doc("config/settings").get();
  const val = mergeSettings(envDefaults(), snap.exists ? snap.data() : {});
  settingsCache = { at: Date.now(), val };
  return val;
}

const OPTS = { region: "us-east1", maxInstances: 3 };
const DEFAULT_PLACES = ["Backyard", "Front yard", "Park", "Trail"];
// Invite codes: 10 characters without look-alikes (0/O, 1/I/L).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function newCode() {
  const b = crypto.randomBytes(10);
  return Array.from(b, x => ALPHABET[x % ALPHABET.length]).join("");
}
const cleanCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
const cleanText = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

function requireUser(req) {
  if (!req.auth || !req.auth.token.email_verified) throw new HttpsError("unauthenticated", "Sign in first");
  return req.auth;
}
function whoAmI(auth) {
  const t = auth.token;
  const name = cleanText(t.name || (t.email || "").split("@")[0] || "Explorer", 40);
  return { name, email: String(t.email || "").toLowerCase() };
}

// Removes uid from a family inside a transaction. Returns the family id if it is now empty and should be deleted.
async function leaveIn(tx, fid, uid) {
  const ref = db().doc(`families/${fid}`);
  const snap = await tx.get(ref);
  if (!snap.exists) return null;
  const d = snap.data();
  const members = (d.members || []).filter(m => m !== uid);
  if (!members.length) {
    tx.delete(ref);
    if (d.inviteCode) tx.delete(db().doc(`invites/${d.inviteCode}`));
    return fid;
  }
  const memberInfo = { ...(d.memberInfo || {}) }; delete memberInfo[uid];
  tx.update(ref, { members, memberInfo, ownerUid: d.ownerUid === uid ? members[0] : d.ownerUid });
  return null;
}
async function deleteFamilyData(fid) {
  await db().recursiveDelete(db().doc(`families/${fid}`)).catch(() => {});
  await getStorage().bucket().deleteFiles({ prefix: `photos/${fid}/` }).catch(() => {});
}

// One callable for everything about families: create, preview an invite, join, leave, new invite link, remove a member.
exports.family = onCall(OPTS, async req => {
  const auth = requireUser(req);
  const uid = auth.uid, me = whoAmI(auth);
  const { action } = req.data || {};
  const userRef = db().doc(`users/${uid}`);

  if (action === "create") {
    const name = cleanText(req.data.name, 40);
    if (!name) throw new HttpsError("invalid-argument", "Give your family a name");
    const settings = await getSettings();
    if (!settings.signupsOpen) throw new HttpsError("failed-precondition", "New families can't be created right now. Ask someone for an invite link instead.");
    const fref = db().collection("families").doc();
    const code = newCode();
    let emptied = null;
    await db().runTransaction(async tx => {
      const u = await tx.get(userRef);
      const old = u.exists ? u.get("familyId") : null;
      const today = new Date().toISOString().slice(0, 10);
      const made = u.exists && u.get("createdDay") === today ? (u.get("createdToday") || 0) : 0;
      if (made >= settings.maxNewFamiliesPerDay) throw new HttpsError("resource-exhausted", "That's a lot of new families today. Try again tomorrow.");
      if (old) emptied = await leaveIn(tx, old, uid);
      tx.set(fref, {
        name, ownerUid: uid, members: [uid], memberInfo: { [uid]: me },
        explorers: [me.name.split(" ")[0] || "Me"], places: DEFAULT_PLACES,
        inviteCode: code, createdAt: new Date().toISOString(),
      });
      tx.set(db().doc(`invites/${code}`), { familyId: fref.id });
      tx.set(userRef, { familyId: fref.id, createdDay: today, createdToday: made + 1 }, { merge: true });
    });
    if (emptied) await deleteFamilyData(emptied);
    return { familyId: fref.id };
  }

  if (action === "preview" || action === "join") {
    const code = cleanCode(req.data.code);
    const inv = code ? await db().doc(`invites/${code}`).get() : null;
    if (!inv || !inv.exists) throw new HttpsError("not-found", "That invite link has expired. Ask for a new one.");
    const fid = inv.get("familyId");
    const fref = db().doc(`families/${fid}`);
    if (action === "preview") {
      const f = await fref.get();
      if (!f.exists) throw new HttpsError("not-found", "That family no longer exists.");
      return { name: f.get("name"), memberCount: (f.get("members") || []).length, already: (f.get("members") || []).includes(uid) };
    }
    let emptied = null;
    const { maxMembers } = await getSettings();
    await db().runTransaction(async tx => {
      const [f, u] = await Promise.all([tx.get(fref), tx.get(userRef)]);
      if (!f.exists) throw new HttpsError("not-found", "That family no longer exists.");
      const members = f.get("members") || [];
      const old = u.exists ? u.get("familyId") : null;
      if (!members.includes(uid) && members.length >= maxMembers) throw new HttpsError("failed-precondition", "That family is full.");
      if (old && old !== fid) emptied = await leaveIn(tx, old, uid);
      if (!members.includes(uid)) tx.update(fref, { members: [...members, uid], [`memberInfo.${uid}`]: me });
      tx.set(userRef, { familyId: fid }, { merge: true });
    });
    if (emptied) await deleteFamilyData(emptied);
    return { familyId: fid };
  }

  // The rest act on the caller's current family.
  const u = await userRef.get();
  const fid = u.exists ? u.get("familyId") : null;
  if (!fid) throw new HttpsError("failed-precondition", "You're not in a family");
  const fref = db().doc(`families/${fid}`);

  if (action === "quota") {
    const [settings, f, used] = await Promise.all([getSettings(), fref.get(), db().doc(`usage/${dayKey()}_${fid}`).get()]);
    const limit = familyLimit(f.exists ? f.data() : {}, settings);
    const n = used.exists ? (used.get("identify") || 0) : 0;
    return { used: n, limit, remaining: Math.max(0, limit - n), paused: settings.paused, blocked: !!(f.exists && f.get("blocked")) };
  }

  if (action === "leave") {
    let emptied = null;
    await db().runTransaction(async tx => {
      emptied = await leaveIn(tx, fid, uid);
      tx.set(userRef, { familyId: null }, { merge: true });
    });
    if (emptied) await deleteFamilyData(emptied);
    return { ok: true };
  }

  if (action === "newInvite") {
    return db().runTransaction(async tx => {
      const f = await tx.get(fref);
      if (!f.exists) throw new HttpsError("not-found", "Family not found");
      if (f.get("ownerUid") !== uid) throw new HttpsError("permission-denied", "Only the family's creator can do that");
      const code = newCode();
      const old = f.get("inviteCode");
      if (old) tx.delete(db().doc(`invites/${old}`));
      tx.set(db().doc(`invites/${code}`), { familyId: fid });
      tx.update(fref, { inviteCode: code });
      return { inviteCode: code };
    });
  }

  if (action === "remove") {
    const target = String(req.data.uid || "");
    if (!target || target === uid) throw new HttpsError("invalid-argument", "Pick someone else to remove");
    const tref = db().doc(`users/${target}`);
    await db().runTransaction(async tx => {
      const [f, t] = await Promise.all([tx.get(fref), tx.get(tref)]);
      if (!f.exists) throw new HttpsError("not-found", "Family not found");
      if (f.get("ownerUid") !== uid) throw new HttpsError("permission-denied", "Only the family's creator can do that");
      const members = (f.get("members") || []).filter(m => m !== target);
      const memberInfo = { ...(f.get("memberInfo") || {}) }; delete memberInfo[target];
      tx.update(fref, { members, memberInfo });
      if (t.exists && t.get("familyId") === fid) tx.set(tref, { familyId: null }, { merge: true });
    });
    return { ok: true };
  }

  throw new HttpsError("invalid-argument", "Unknown action");
});

const familyLimit = (fam, settings) => Number.isInteger(fam?.dailyLimit) ? fam.dailyLimit : settings.familyDailyLimit;

// Checks every limit and counts the attempt before calling Claude. Throws a friendly error when a limit is hit.
async function checkAndCount(fid, fam, settings) {
  if (settings.paused) throw new HttpsError("unavailable", "Photo naming is switched off for a little while. You can still save finds and name them yourself.");
  if (fam.blocked) throw new HttpsError("permission-denied", "This family can't name photos right now. You can still name finds yourself.");
  const day = dayKey(), month = monthKey();
  const gref = db().doc(`usage/${day}`), fref = db().doc(`usage/${day}_${fid}`), mref = db().doc(`usage/m_${month}`);
  return db().runTransaction(async tx => {
    const [g, f, m] = await Promise.all([tx.get(gref), tx.get(fref), tx.get(mref)]);
    const gn = (g.exists ? g.get("identify") || 0 : 0) + 1;
    const fn = (f.exists ? f.get("identify") || 0 : 0) + 1;
    const limit = familyLimit(fam, settings);
    if (fn > limit) throw new HttpsError("resource-exhausted", "That’s all the photos for today! Try again tomorrow, or name this one yourself.");
    if (gn > settings.globalDailyLimit) throw new HttpsError("resource-exhausted", "YardDex is very busy today. Try again tomorrow, or name this one yourself.");
    const spent = m.exists ? m.get("costUsd") || 0 : 0;
    if (settings.monthlyBudgetUsd > 0 && spent >= settings.monthlyBudgetUsd) throw new HttpsError("resource-exhausted", "YardDex has used this month’s photo budget. You can still name finds yourself.");
    tx.set(gref, { identify: gn, day }, { merge: true });
    tx.set(fref, { identify: fn, day, fid }, { merge: true });
    return { used: fn, limit };
  });
}

// Records tokens, cost and the outcome of one identification for the admin dashboard.
async function recordResult({ fid, famName, uid, model, usage, ok, error, name, ms }) {
  const day = dayKey(), month = monthKey(), cost = usage ? costUsd(model, usage) : 0;
  const inc = {
    inputTokens: FieldValue.increment(usage?.input_tokens || 0),
    outputTokens: FieldValue.increment(usage?.output_tokens || 0),
    costUsd: FieldValue.increment(cost),
    errors: FieldValue.increment(ok ? 0 : 1),
  };
  const b = db().batch();
  b.set(db().doc(`usage/${day}`), inc, { merge: true });
  b.set(db().doc(`usage/${day}_${fid}`), inc, { merge: true });
  b.set(db().doc(`usage/m_${month}`), { ...inc, identify: FieldValue.increment(1), month }, { merge: true });
  b.set(db().doc(`usage/m_${month}_${fid}`), { ...inc, identify: FieldValue.increment(1), month, fid }, { merge: true });
  b.set(db().collection("idlog").doc(), {
    at: new Date().toISOString(), fid, family: famName || "", uid, model, ok, error: error || "", name: name || "",
    inputTokens: usage?.input_tokens || 0, outputTokens: usage?.output_tokens || 0, costUsd: cost, ms,
  });
  await b.commit().catch(e => console.error("usage record failed", e));
}

async function ask(client, model, effort, image, prompt) {
  return client.messages.create({
    model,
    // Current models think before answering, and thinking counts toward max_tokens: leave room for it.
    // Effort is set in the admin dashboard (default high: helps spot small birds and tell similar species apart).
    max_tokens: 8000,
    output_config: { effort },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
      { type: "text", text: prompt },
    ] }],
  });
}

exports.identify = onCall(
  { ...OPTS, secrets: [ANTHROPIC_API_KEY], memory: "512MiB", timeoutSeconds: 90 },
  async req => {
    const auth = requireUser(req);
    const u = await db().doc(`users/${auth.uid}`).get();
    const fid = u.exists ? u.get("familyId") : null;
    const f = fid ? await db().doc(`families/${fid}`).get() : null;
    if (!f || !f.exists || !(f.get("members") || []).includes(auth.uid)) throw new HttpsError("permission-denied", "Join a family first");
    const fam = f.data();

    const { image, place, month, lat, lon } = req.data || {};
    if (typeof image !== "string" || image.length < 1000 || image.length > 7_000_000) throw new HttpsError("invalid-argument", "Bad image");
    const settings = await getSettings();
    const { used, limit } = await checkAndCount(fid, fam, settings);
    const remaining = Math.max(0, limit - used);

    // Only a rough area (about 10 km) goes to Claude, never the exact spot.
    const okNum = (v, m) => typeof v === "number" && isFinite(v) && Math.abs(v) <= m;
    const area = okNum(lat, 90) && okNum(lon, 180) ? `near latitude ${lat.toFixed(1)}, longitude ${lon.toFixed(1)}` : "";
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const prompt = buildPrompt(String(place || "outside").slice(0, 40), String(month || "").slice(0, 12), area);
    const started = Date.now();
    let model = settings.model, msg;
    const log = (extra) => recordResult({ fid, famName: fam.name, uid: auth.uid, model, usage: msg?.usage, ms: Date.now() - started, ...extra });
    try {
      try {
        msg = await ask(client, model, settings.effort, image, prompt);
      } catch (e) {
        if (e?.status !== 404) throw e;
        const list = await client.models.list({ limit: 50 });
        model = (list.data.find(m => /haiku/i.test(m.id)) || list.data[0]).id;
        msg = await ask(client, model, settings.effort, image, prompt);
      }
    } catch (e) {
      await log({ ok: false, error: `Claude error ${e?.status || ""} ${String(e?.message || e).slice(0, 120)}` });
      throw new HttpsError("unavailable", "Claude is busy, try again");
    }
    // Claude's safety checks can occasionally decline a photo; that is a normal reply, not an error.
    if (msg.stop_reason === "refusal") {
      await log({ ok: false, error: "declined by safety check" });
      throw new HttpsError("failed-precondition", "Claude couldn't identify that one. Try another photo, or name it yourself.");
    }
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
    let card;
    try { card = parseCard(text); }
    catch {
      await log({ ok: false, error: `unreadable reply (stop: ${msg.stop_reason})` });
      throw new HttpsError("internal", "Couldn't read Claude's answer");
    }
    await log({ ok: true, name: card.found ? card.name : "Mystery" });
    return { ...card, remaining };
  }
);

// ---------- admin dashboard ----------
function isAdmin(auth) {
  const list = ADMIN_EMAILS.value().toLowerCase().split(/[\s,;]+/).filter(Boolean);
  return !!auth?.token?.email_verified && list.includes(String(auth.token.email || "").toLowerCase());
}
const num = (snap, k) => (snap && snap.exists ? Number(snap.get(k)) || 0 : 0);

exports.admin = onCall({ ...OPTS, timeoutSeconds: 120 }, async req => {
  const auth = requireUser(req);
  const { action } = req.data || {};
  if (action === "whoami") return { admin: isAdmin(auth), configured: ADMIN_EMAILS.value().trim() !== "" };
  if (!isAdmin(auth)) throw new HttpsError("permission-denied", "This account isn't an admin.");

  if (action === "overview") {
    const settings = await getSettings(true);
    const now = new Date(), today = dayKey(now), month = monthKey(now);
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const days = [...Array(30)].map((_, i) => dayKey(new Date(now.getTime() - (29 - i) * 864e5)));
    const [daySnaps, monthSnaps, famSnap, logSnap] = await Promise.all([
      db().getAll(...days.map(d => db().doc(`usage/${d}`))),
      db().getAll(db().doc(`usage/m_${month}`), db().doc(`usage/m_${monthKey(prev)}`)),
      db().collection("families").orderBy("createdAt", "desc").limit(300).get(),
      db().collection("idlog").orderBy("at", "desc").limit(60).get(),
    ]);
    const fams = famSnap.docs;
    const [famToday, famMonth, findCounts] = await Promise.all([
      fams.length ? db().getAll(...fams.map(d => db().doc(`usage/${today}_${d.id}`))) : [],
      fams.length ? db().getAll(...fams.map(d => db().doc(`usage/m_${month}_${d.id}`))) : [],
      Promise.all(fams.map(d => d.ref.collection("finds").count().get().then(s => s.data().count).catch(() => null))),
    ]);
    const usageOf = s => ({ photos: num(s, "identify"), costUsd: num(s, "costUsd"), errors: num(s, "errors"), inputTokens: num(s, "inputTokens"), outputTokens: num(s, "outputTokens") });
    return {
      settings, models: MODEL_CHOICES.map(m => ({ ...m, price: PRICES[m.id] })), efforts: EFFORTS,
      today, month,
      days: days.map((d, i) => ({ day: d, ...usageOf(daySnaps[i]) })),
      thisMonth: usageOf(monthSnaps[0]), lastMonth: usageOf(monthSnaps[1]),
      families: fams.map((d, i) => {
        const f = d.data();
        return {
          id: d.id, name: f.name, createdAt: f.createdAt, blocked: !!f.blocked,
          dailyLimit: Number.isInteger(f.dailyLimit) ? f.dailyLimit : null,
          members: (f.members || []).map(uid => ({ uid, ...(f.memberInfo?.[uid] || {}), owner: uid === f.ownerUid })),
          finds: findCounts[i], today: usageOf(famToday[i]), month: usageOf(famMonth[i]),
        };
      }),
      log: logSnap.docs.map(d => d.data()),
    };
  }

  if (action === "saveSettings") {
    let patch;
    try { patch = cleanSettings(req.data.patch); } catch (e) { throw new HttpsError("invalid-argument", e.message); }
    await db().doc("config/settings").set({ ...patch, updatedAt: new Date().toISOString(), updatedBy: String(auth.token.email || "") }, { merge: true });
    return { settings: await getSettings(true) };
  }

  const fid = String(req.data?.fid || "");
  const fref = fid ? db().doc(`families/${fid}`) : null;
  if (!fref) throw new HttpsError("invalid-argument", "Pick a family");

  if (action === "setFamily") {
    const patch = {};
    if ("blocked" in req.data) patch.blocked = !!req.data.blocked;
    if ("dailyLimit" in req.data) {
      const v = req.data.dailyLimit;
      if (v === null || v === "") patch.dailyLimit = FieldValue.delete();
      else if (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 1000) patch.dailyLimit = Number(v);
      else throw new HttpsError("invalid-argument", "Daily limit must be a whole number from 0 to 1000, or blank for the default");
    }
    await fref.update(patch);
    return { ok: true };
  }

  if (action === "deleteFamily") {
    const f = await fref.get();
    if (!f.exists) return { ok: true };
    const b = db().batch();
    for (const uid of f.get("members") || []) b.set(db().doc(`users/${uid}`), { familyId: null }, { merge: true });
    if (f.get("inviteCode")) b.delete(db().doc(`invites/${f.get("inviteCode")}`));
    await b.commit();
    await deleteFamilyData(fid);
    return { ok: true };
  }

  throw new HttpsError("invalid-argument", "Unknown action");
});
