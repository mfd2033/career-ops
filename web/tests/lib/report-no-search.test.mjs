// Tests for the shared report-number search rule used by the company/role
// search boxes (tracker table, follow-ups, explore results). The whole point is
// that it is ONE rule, so it is locked here once rather than re-tested three
// times against divergent copies.
//
// Run:  node --test tests/lib/report-no-search.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesReportNo } from "../../src/lib/report-no-search.mjs";

test("a bare number matches the row's report number", () => {
  assert.equal(matchesReportNo("64", "64"), true);
  assert.equal(matchesReportNo("64", 64), true);
});

test("'#' prefix and zero padding are tolerated on both sides", () => {
  assert.equal(matchesReportNo("#64", "64"), true);
  assert.equal(matchesReportNo("64", "064"), true);
  assert.equal(matchesReportNo("#064", "64"), true);
  assert.equal(matchesReportNo(" 42 ", "042"), true);
});

test("non-numeric text is never read as a report number", () => {
  assert.equal(matchesReportNo("Acme", "64"), false);
  assert.equal(matchesReportNo("10x", "10"), false);
  assert.equal(matchesReportNo("3 years", "3"), false);
  assert.equal(matchesReportNo("", "64"), false);
  assert.equal(matchesReportNo("#", "64"), false);
});

test("a number query does not match a different row", () => {
  assert.equal(matchesReportNo("64", "65"), false);
});

test("an absent report number never matches", () => {
  assert.equal(matchesReportNo("64", undefined), false);
  assert.equal(matchesReportNo("64", null), false);
  assert.equal(matchesReportNo("64", ""), false);
});
