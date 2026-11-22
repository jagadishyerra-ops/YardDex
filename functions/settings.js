// App-wide settings the admin dashboard can change without a redeploy. Kept separate so it can be tested without Firebase.

// Claude API prices in US dollars per million tokens: [input, output]. Thinking counts as output.
const PRICES = {
  "claude-haiku-5-5": [0.10, 0.50],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};
const MODEL_CHOICES = [
  { id: "claude-haiku-5-5", label: "Haiku 5.5 (cheapest)" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 (better at rare species)" },
  { id: "claude-opus-5-5", label: "Opus 5.5 (most capable)" },
];
const EFFORTS = ["low", "medium", "high"];

// Unknown models are priced like the most expensive choice, so the budget errs on the safe side.
function costUsd(model, usage) {
  const [pin, pout] = PRICES[model] || PRICES["claude-opus-5-5"];
  return ((usage?.input_tokens || 0) * pin + (usage?.output_tokens || 0) * pout) / 1e6;
}

const LIMITS = {
  familyDailyLimit: [0, 1000],
  globalDailyLimit: [0, 100000],
  maxNewFamiliesPerDay: [0, 50],
  maxMembers: [1, 200],
};

// Validates a partial update from the dashboard. Unknown or invalid fields throw, so nothing half-applies.
function cleanSettings(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "model") {
      if (!PRICES[v]) throw new Error(`Unknown model ${v}`);
      out.model = v;
    } else if (k === "effort") {
      if (!EFFORTS.includes(v)) throw new Error(`Unknown effort ${v}`);
      out.effort = v;
    } else if (k in LIMITS) {
      const n = Number(v), [lo, hi] = LIMITS[k];
      if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${k} must be a whole number from ${lo} to ${hi}`);
      out[k] = n;
    } else if (k === "monthlyBudgetUsd") {
      const n = Number(v);
      if (!isFinite(n) || n < 0 || n > 10000) throw new Error("Monthly budget must be between $0 and $10,000 (0 = no cap)");
      if (n > 0 && n < 0.01) throw new Error("Monthly budget must be at least $0.01 (or 0 for no cap)");
      out[k] = Math.round(n * 100) / 100;
    } else if (k === "signupsOpen" || k === "paused") {
      if (typeof v !== "boolean") throw new Error(`${k} must be on or off`);
      out[k] = v;
    } else {
      throw new Error(`Unknown setting ${k}`);
    }
  }
  return out;
}

// Stored values win over defaults, but only valid ones (a bad hand-edit in the console can't break the app).
function mergeSettings(defaults, stored) {
  const merged = { ...defaults };
  for (const [k, v] of Object.entries(stored || {})) {
    try { Object.assign(merged, cleanSettings({ [k]: v })); } catch { /* ignore invalid stored value */ }
  }
  return merged;
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);   // UTC day, e.g. 2026-11-22
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);  // UTC month, e.g. 2026-11

module.exports = { PRICES, MODEL_CHOICES, EFFORTS, costUsd, cleanSettings, mergeSettings, dayKey, monthKey };
