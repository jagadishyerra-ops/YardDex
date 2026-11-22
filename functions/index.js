const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString, defineInt } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const crypto = require("node:crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { buildPrompt, parseCard } = require("./prompt");

initializeApp();
const db = () => getFirestore();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
// Any current vision-capable Claude model works. If this one is retired, the function falls back to the newest Haiku.
const CLAUDE_MODEL = defineString("CLAUDE_MODEL", { default: "claude-haiku-5-5" });
// Photos one family can identify per day.
const DAILY_LIMIT = defineInt("DAILY_LIMIT", { default: 60 });
// Photos the whole app can identify per day, across every family. Protects your Claude API bill.
const GLOBAL_DAILY_LIMIT = defineInt("GLOBAL_DAILY_LIMIT", { default: 300 });
// Most people one family can have.
const MAX_MEMBERS = 30;
// Families one person may create per day (stops someone making endless families to dodge DAILY_LIMIT).
const MAX_NEW_FAMILIES_PER_DAY = 3;

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
    const fref = db().collection("families").doc();
    const code = newCode();
    let emptied = null;
    await db().runTransaction(async tx => {
      const u = await tx.get(userRef);
      const old = u.exists ? u.get("familyId") : null;
      const today = new Date().toISOString().slice(0, 10);
      const made = u.exists && u.get("createdDay") === today ? (u.get("createdToday") || 0) : 0;
      if (made >= MAX_NEW_FAMILIES_PER_DAY) throw new HttpsError("resource-exhausted", "That's a lot of new families today. Try again tomorrow.");
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
    await db().runTransaction(async tx => {
      const [f, u] = await Promise.all([tx.get(fref), tx.get(userRef)]);
      if (!f.exists) throw new HttpsError("not-found", "That family no longer exists.");
      const members = f.get("members") || [];
      const old = u.exists ? u.get("familyId") : null;
      if (!members.includes(uid) && members.length >= MAX_MEMBERS) throw new HttpsError("failed-precondition", "That family is full.");
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

async function countUsage(fid) {
  const day = new Date().toISOString().slice(0, 10);
  const gref = db().doc(`usage/${day}`), fref = db().doc(`usage/${day}_${fid}`);
  return db().runTransaction(async tx => {
    const [g, f] = await Promise.all([tx.get(gref), tx.get(fref)]);
    const gn = (g.exists ? g.get("identify") : 0) + 1;
    const fn = (f.exists ? f.get("identify") : 0) + 1;
    if (fn > DAILY_LIMIT.value()) throw new HttpsError("resource-exhausted", "Daily limit reached");
    if (gn > GLOBAL_DAILY_LIMIT.value()) throw new HttpsError("resource-exhausted", "YardDex is very busy today");
    tx.set(gref, { identify: gn }, { merge: true });
    tx.set(fref, { identify: fn }, { merge: true });
  });
}

async function ask(client, model, image, prompt) {
  return client.messages.create({
    model,
    // Current models think before answering, and thinking counts toward max_tokens: leave room for it.
    // High effort helps spot small birds and tell similar species apart; with Haiku it's still ~0.1¢ a photo.
    max_tokens: 8000,
    output_config: { effort: "high" },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
      { type: "text", text: prompt },
    ] }],
  });
}

exports.identify = onCall(
  { ...OPTS, secrets: [ANTHROPIC_API_KEY], memory: "512MiB", timeoutSeconds: 60 },
  async req => {
    const auth = requireUser(req);
    const u = await db().doc(`users/${auth.uid}`).get();
    const fid = u.exists ? u.get("familyId") : null;
    const f = fid ? await db().doc(`families/${fid}`).get() : null;
    if (!f || !f.exists || !(f.get("members") || []).includes(auth.uid)) throw new HttpsError("permission-denied", "Join a family first");

    const { image, place, month, lat, lon } = req.data || {};
    if (typeof image !== "string" || image.length < 1000 || image.length > 7_000_000) throw new HttpsError("invalid-argument", "Bad image");
    await countUsage(fid);

    // Only a rough area (about 10 km) goes to Claude, never the exact spot.
    const okNum = (v, m) => typeof v === "number" && isFinite(v) && Math.abs(v) <= m;
    const area = okNum(lat, 90) && okNum(lon, 180) ? `near latitude ${lat.toFixed(1)}, longitude ${lon.toFixed(1)}` : "";
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const prompt = buildPrompt(String(place || "outside").slice(0, 40), String(month || "").slice(0, 12), area);
    let msg;
    try {
      msg = await ask(client, CLAUDE_MODEL.value(), image, prompt);
    } catch (e) {
      if (e?.status !== 404) throw new HttpsError("unavailable", "Claude is busy, try again");
      const list = await client.models.list({ limit: 50 });
      const fallback = list.data.find(m => /haiku/i.test(m.id)) || list.data[0];
      msg = await ask(client, fallback.id, image, prompt);
    }
    // Claude's safety checks can occasionally decline a photo; that is a normal reply, not an error.
    if (msg.stop_reason === "refusal") throw new HttpsError("failed-precondition", "Claude couldn't identify that one. Try another photo.");
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
    try { return parseCard(text); }
    catch { throw new HttpsError("internal", "Couldn't read Claude's answer"); }
  }
);
