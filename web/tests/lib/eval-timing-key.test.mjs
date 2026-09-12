// Run:  node --test tests/lib/eval-timing-key.test.mjs
//
// Locks the 评估用时 join key (ADR-0016/0017): a re-evaluation reserves a NEW
// report number while merge-tracker keeps the row's original #N and swaps its
// Report link — so the panel follows the LINK, falling back to the row number
// only for legacy/unlinked rows.
import { test } from "node:test";
import assert from "node:assert/strict";

import { currentReportNum, evalTimingKey } from "../../src/lib/eval-timing-key.mjs";

test("currentReportNum: parses the report number out of the tracker link", () => {
  assert.equal(currentReportNum("[793](reports/793-acme-2026-09-01.md)"), "793");
  assert.equal(currentReportNum("[035](../reports/035-confidential-hays-2026-07-06.md)"), "35");
});

test("currentReportNum: no link → null (sentinels, empty, missing)", () => {
  assert.equal(currentReportNum("—"), null);
  assert.equal(currentReportNum(""), null);
  assert.equal(currentReportNum(null), null);
  assert.equal(currentReportNum(undefined), null);
  // A bare number with no link is not the documented spelling — not trusted.
  assert.equal(currentReportNum("793"), null);
});

test("evalTimingKey: follows the row's CURRENT report link (re-eval)", () => {
  // Re-eval outcome: row #250 kept, link now points at the new report 812 —
  // the panel must show the latest evaluation, keyed by 812.
  assert.equal(evalTimingKey({ n: "250", report: "[812](../reports/812-acme-2026-09-10.md)" }), "812");
});

test("evalTimingKey: falls back to the row number when the link is missing", () => {
  assert.equal(evalTimingKey({ n: "250", report: "—" }), "250");
  assert.equal(evalTimingKey({ n: "035", report: null }), "35");
  assert.equal(evalTimingKey({ n: "252" }), "252");
});

test("evalTimingKey: zero-pad-insensitive on both sides", () => {
  // The timing TSV writer and the link label may disagree on padding.
  assert.equal(evalTimingKey({ n: "0252", report: "—" }), "252");
});

test("evalTimingKey: missing row → empty string (lookup misses, panel hides)", () => {
  assert.equal(evalTimingKey(null), "");
  assert.equal(evalTimingKey(undefined), "");
});
