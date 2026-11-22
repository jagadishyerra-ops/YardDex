const test = require("node:test");
const assert = require("node:assert");
const { costUsd, cleanSettings, mergeSettings, dayKey, monthKey } = require("../settings");

test("cost uses the model's price, thinking counted as output", () => {
  const c = costUsd("claude-haiku-5-5", { input_tokens: 2000, output_tokens: 1000 });
  assert.ok(Math.abs(c - (2000 * 0.10 + 1000 * 0.50) / 1e6) < 1e-12);
  assert.ok(costUsd("some-future-model", { input_tokens: 1e6 }) >= 4, "unknown models priced high");
});
test("settings validation accepts good values and rejects bad ones", () => {
  assert.deepEqual(cleanSettings({ familyDailyLimit: "12", paused: true, monthlyBudgetUsd: "5.555" }),
    { familyDailyLimit: 12, paused: true, monthlyBudgetUsd: 5.56 });
  assert.throws(() => cleanSettings({ familyDailyLimit: -1 }));
  assert.throws(() => cleanSettings({ model: "gpt" }));
  assert.throws(() => cleanSettings({ paused: "yes" }));
  assert.throws(() => cleanSettings({ hacker: 1 }));
  assert.throws(() => cleanSettings({ monthlyBudgetUsd: 0.0001 }), /at least/);
  assert.deepEqual(cleanSettings({ monthlyBudgetUsd: 0 }), { monthlyBudgetUsd: 0 });
});
test("stored settings override defaults, invalid stored values are ignored", () => {
  const m = mergeSettings({ familyDailyLimit: 10, effort: "high" }, { familyDailyLimit: 25, effort: "extreme" });
  assert.equal(m.familyDailyLimit, 25); assert.equal(m.effort, "high");
});
test("day and month keys are UTC", () => {
  const d = new Date("2026-11-22T23:30:00Z");
  assert.equal(dayKey(d), "2026-11-22"); assert.equal(monthKey(d), "2026-11");
});
