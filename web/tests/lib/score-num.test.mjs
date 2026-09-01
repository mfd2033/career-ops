// Tests for score-num.mjs using Node's built-in test runner.
//
// Run:  node --test tests/lib/score-num.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreNum } from "../../src/lib/score-num.mjs";

test("parses the leading number from a score string", () => {
  assert.equal(scoreNum("4.1/5"), 4.1);
  assert.equal(scoreNum("3.0"), 3);
  assert.equal(scoreNum("5/5"), 5);
});

test("handles non-numeric scores as NaN", () => {
  assert.ok(Number.isNaN(scoreNum("")));
  assert.ok(Number.isNaN(scoreNum("B+")));
  assert.ok(Number.isNaN(scoreNum("—")));
  assert.ok(Number.isNaN(scoreNum("N/A")));
});

test("letter-with-number forms take the first number", () => {
  assert.equal(scoreNum("B+ 3.5"), 3.5);
  assert.equal(scoreNum("Score: 2.8/5"), 2.8);
});
