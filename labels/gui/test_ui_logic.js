const test = require("node:test");
const assert = require("node:assert/strict");
const { derive } = require("./static/logic.js");

test("date-opened use-by follows its opening date", () => {
  assert.equal(derive("days:14", { opened: "2026-09-17" }), "2026-10-01");
});

test("day derivation crosses leap day and year boundaries", () => {
  assert.equal(derive("days:1", { opened: "2028-02-28" }), "2028-02-29");
  assert.equal(derive("days:1", { opened: "2026-12-31" }), "2027-01-01");
});

test("invalid dates and derivations stay blank", () => {
  assert.equal(derive("days:7", { opened: "2026-02-31" }), "");
  assert.equal(derive("days:nope", { opened: "2026-09-17" }), "");
});

test("existing batch and month rules remain unchanged", () => {
  assert.equal(
    derive("batch", { packed: "2026-09-17", pot: "3" }), "1709GA3");
  assert.equal(
    derive("months:6", { packed: "2026-09-17" }), "2027-03-01");
});

test("months:N can name a source field other than packed", () => {
  // The Desserts label has no "packed" field, only "produced", so its use-by
  // names its source explicitly rather than relying on the default.
  assert.equal(
    derive("months:3:produced", { produced: "2026-09-23" }), "2026-12-01");
  // A form that has not filled in "produced" yet derives nothing, the same
  // as every other date-derived field with a blank source.
  assert.equal(derive("months:3:produced", { produced: "" }), "");
});

test("box seal best-before is exactly a year from packing", () => {
  assert.equal(derive("years:1", { packed: "2026-09-18" }), "2027-09-18");
  // 2028 is a leap year, 2029 is not: 29 Feb falls back to 28 Feb rather
  // than rolling into March, mirroring years_on() in server.py.
  assert.equal(derive("years:1", { packed: "2028-02-29" }), "2029-02-28");
});
