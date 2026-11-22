const test = require("node:test");
const assert = require("node:assert");
const { buildPrompt, parseCard } = require("../prompt");

test("prompt mentions place and month", () => {
  const p = buildPrompt("Backyard", "November");
  assert.match(p, /Backyard/); assert.match(p, /November/);
});
test("parses fenced JSON and clamps values", () => {
  const c = parseCard('```json\n{"found":true,"name":"Northern Cardinal","kind":"bird","rarity":9,"confidence":"sure","fact":"x"}\n```');
  assert.equal(c.name, "Northern Cardinal"); assert.equal(c.rarity, 5); assert.equal(c.kind, "bird");
});
test("unknown kind becomes other; missing name becomes Mystery", () => {
  const c = parseCard('{"found":false,"kind":"dragon"}');
  assert.equal(c.kind, "other"); assert.equal(c.name, "Mystery"); assert.equal(c.found, false); assert.equal(c.rarity, 1);
});
test("throws on non-JSON", () => { assert.throws(() => parseCard("sorry")); });
test("prompt uses the family's rough area when given, and works without it", () => {
  const near = buildPrompt("Park", "May", "near latitude 51.5, longitude -0.1");
  assert.match(near, /latitude 51\.5/); assert.match(near, /in that area/);
  const none = buildPrompt("Park", "May", "");
  assert.match(none, /location is unknown/); assert.doesNotMatch(none, /Gwinnett/);
});
test("prompt tells Claude to prefer small animals like birds over the background", () => {
  const p = buildPrompt("Backyard", "June", "");
  assert.match(p, /bird/i); assert.match(p, /not what it is sitting on/);
});
