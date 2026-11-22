// Prompt and response cleanup for the identify function. Kept separate so it can be tested without Firebase.
const KINDS = ["bird","bug","spider","plant","tree","flower","fungus","mammal","reptile","amphibian","fish","nature-object","other"];

function buildPrompt(place, month) {
  return `You are the friendly naturalist for YardDex, a family nature field guide. The explorers are kids aged 6 and 3 in Gwinnett County, Georgia, USA. It is ${month}. This photo was taken at: ${place}.
Identify the main living thing or nature object in the photo (animal, bug, plant, tree, flower, mushroom, or a treasure like a feather, pinecone, nest, track, shell or rock).
Reply with ONLY a JSON object, no other text:
{"found": true or false (false if there is no nature subject),
 "name": "common name, as specific as you can be confidently (e.g. 'Carolina Wren'); use a broader name like 'Orb-weaver Spider' if unsure; 'Mystery' if found is false",
 "scientific": "scientific name or empty string",
 "kind": one of ${KINDS.map(k => `"${k}"`).join(",")},
 "confidence": "sure" | "pretty sure" | "best guess",
 "fact": "one amazing true fact a 6-year-old would love, under 25 words, simple words",
 "lookFor": "one thing to notice in THIS photo, under 15 words",
 "rarity": 1-5 for how often a family would find this in Gwinnett County in ${month} (1 = every day, 2 = common, 3 = uncommon, 4 = rare, 5 = legendary once-in-years),
 "rarityWhy": "why that rarity, under 12 words",
 "safety": "short kid warning if it can sting, bite, is poisonous or should not be touched; else empty string"}`;
}

function parseCard(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON in reply");
  const r = JSON.parse(s.slice(a, b + 1));
  const str = (v, n) => String(v ?? "").slice(0, n);
  return {
    found: r.found !== false,
    name: str(r.name || "Mystery", 80),
    scientific: str(r.scientific, 80),
    kind: KINDS.includes(r.kind) ? r.kind : "other",
    confidence: ["sure", "pretty sure", "best guess"].includes(r.confidence) ? r.confidence : "best guess",
    fact: str(r.fact, 240),
    lookFor: str(r.lookFor, 160),
    rarity: Math.max(1, Math.min(5, parseInt(r.rarity, 10) || 1)),
    rarityWhy: str(r.rarityWhy, 120),
    safety: str(r.safety, 160),
  };
}

module.exports = { buildPrompt, parseCard, KINDS };
