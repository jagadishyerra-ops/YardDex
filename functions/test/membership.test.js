const test = require("node:test");
const assert = require("node:assert");
const { idsOf, withFamily, withoutFamily } = require("../membership");

test("old one-family user docs read as a one-item list", () => {
  assert.deepEqual(idsOf({ familyId: "a" }), ["a"]);
  assert.deepEqual(idsOf({ familyId: null }), []);
  assert.deepEqual(idsOf(undefined), []);
  assert.deepEqual(idsOf({ familyIds: ["a", "b"], familyId: "b" }), ["a", "b"]);
});
test("joining adds the family and switches to it, without duplicates", () => {
  assert.deepEqual(withFamily({ familyId: "a" }, "b"), { familyIds: ["a", "b"], familyId: "b" });
  assert.deepEqual(withFamily({ familyIds: ["a", "b"], familyId: "b" }, "a"), { familyIds: ["a", "b"], familyId: "a" });
  assert.deepEqual(withFamily(null, "a"), { familyIds: ["a"], familyId: "a" });
});
test("leaving the current family switches to another one", () => {
  assert.deepEqual(withoutFamily({ familyIds: ["a", "b"], familyId: "b" }, "b"), { familyIds: ["a"], familyId: "a" });
  assert.deepEqual(withoutFamily({ familyIds: ["a", "b"], familyId: "a" }, "b"), { familyIds: ["a"], familyId: "a" });
  assert.deepEqual(withoutFamily({ familyId: "a" }, "a"), { familyIds: [], familyId: null });
});
