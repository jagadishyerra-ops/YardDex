const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString, defineInt } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");
const { buildPrompt, parseCard } = require("./prompt");

admin.initializeApp();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
// Any current vision-capable Claude model works. If this one is retired, the function falls back to the newest Sonnet.
const CLAUDE_MODEL = defineString("CLAUDE_MODEL", { default: "claude-sonnet-4-5" });
const DAILY_LIMIT = defineInt("DAILY_LIMIT", { default: 60 });

async function isFamily(email) {
  if (!email) return false;
  const snap = await admin.firestore().doc("config/family").get();
  const members = (snap.exists && snap.get("members")) || [];
  return members.map(m => String(m).toLowerCase()).includes(email.toLowerCase());
}

async function countToday() {
  const day = new Date().toISOString().slice(0, 10);
  const ref = admin.firestore().doc(`usage/${day}`);
  return admin.firestore().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const n = (snap.exists ? snap.get("identify") : 0) + 1;
    if (n > DAILY_LIMIT.value()) throw new HttpsError("resource-exhausted", "Daily limit reached");
    tx.set(ref, { identify: n }, { merge: true });
    return n;
  });
}

async function ask(client, model, image, prompt) {
  return client.messages.create({
    model,
    max_tokens: 700,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
      { type: "text", text: prompt },
    ] }],
  });
}

exports.identify = onCall(
  { region: "us-east1", secrets: [ANTHROPIC_API_KEY], memory: "512MiB", timeoutSeconds: 60, maxInstances: 3 },
  async req => {
    const email = req.auth?.token?.email;
    if (!req.auth || !req.auth.token.email_verified) throw new HttpsError("unauthenticated", "Sign in first");
    if (!(await isFamily(email))) throw new HttpsError("permission-denied", "Not on the family list");

    const { image, place, month } = req.data || {};
    if (typeof image !== "string" || image.length < 1000 || image.length > 7_000_000) throw new HttpsError("invalid-argument", "Bad image");
    await countToday();

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const prompt = buildPrompt(String(place || "outside").slice(0, 40), String(month || "").slice(0, 12));
    let msg;
    try {
      msg = await ask(client, CLAUDE_MODEL.value(), image, prompt);
    } catch (e) {
      if (e?.status !== 404) throw new HttpsError("unavailable", "Claude is busy, try again");
      const list = await client.models.list({ limit: 50 });
      const fallback = list.data.find(m => /sonnet/i.test(m.id)) || list.data[0];
      msg = await ask(client, fallback.id, image, prompt);
    }
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
    try { return parseCard(text); }
    catch { throw new HttpsError("internal", "Couldn't read Claude's answer"); }
  }
);
