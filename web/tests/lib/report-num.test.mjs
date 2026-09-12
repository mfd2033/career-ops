// Run:  node --test tests/lib/report-num.test.mjs
//
// Locks the worker → report-number resolution (ADR-0018): where the number comes
// from, which source wins, and — just as load-bearing — that resolving a number
// does NOT hand a worker an evaluation's 评估用时.
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveJobReportNum, showsEvalDuration } from "../../src/lib/report-num.mjs";
import { normalizeUrl } from "../../src/lib/core/url-key.mjs";

const POSTING = "https://jobs.example.com/jobs/1?utm_source=news";
const index = { [normalizeUrl(POSTING)]: { score: "4/5", reportNum: "812" } };

test("resolveJobReportNum: the captured number wins over every other source", () => {
  assert.equal(resolveJobReportNum({ reportNum: "035", kind: "pdf", input: "035" }, null), "035");
  // …even when the record also carries a resolvable posting URL and a "#N"
  // subtitle: a re-evaluation moved that posting to report 812, but THIS worker
  // still references the report it was fired with.
  assert.equal(
    resolveJobReportNum({ reportNum: "35", kind: "pdf", input: POSTING, subtitle: "#900" }, index),
    "35",
  );
});

test("resolveJobReportNum: a non-numeric captured value is not trusted", () => {
  assert.equal(resolveJobReportNum({ reportNum: "n/a", kind: "pdf", input: POSTING }, index), "812");
  assert.equal(resolveJobReportNum({ reportNum: "#35", kind: "pdf" }, null), null);
});

test("resolveJobReportNum: posting URL → the report-status index", () => {
  assert.equal(resolveJobReportNum({ input: POSTING, kind: "evaluate" }, index), "812");
  // Index still loading → the URL source doesn't answer (and there is no local
  // pool subtitle on a locally-started card), so the card shows no jump yet.
  assert.equal(resolveJobReportNum({ input: POSTING, kind: "evaluate" }, null), null);
  // Unknown posting → nothing to jump to.
  assert.equal(resolveJobReportNum({ input: "https://jobs.example.com/jobs/2", kind: "evaluate" }, index), null);
});

test("resolveJobReportNum: the pool cards' `#N` subtitle", () => {
  assert.equal(resolveJobReportNum({ subtitle: "#42", kind: "batch-evaluate" }, null), "42");
  assert.equal(resolveJobReportNum({ subtitle: "Evaluating 3 postings" }, null), null);
});

test("resolveJobReportNum: pdf fallback for records persisted before the field", () => {
  // localStorage keeps up to 40 records written before `reportNum` existed.
  assert.equal(resolveJobReportNum({ kind: "pdf", input: " 35 ", subtitle: "tailored for this role" }, null), "35");
  // …but ONLY for pdf: `input` is a company name / a target elsewhere.
  assert.equal(resolveJobReportNum({ kind: "fix-portal", input: "35" }, null), null);
  assert.equal(resolveJobReportNum({ kind: "research", input: "35" }, null), null);
  assert.equal(resolveJobReportNum({ kind: "pdf", input: "acme" }, null), null);
});

test("resolveJobReportNum: nothing to resolve → null, never a guess", () => {
  assert.equal(resolveJobReportNum(null, index), null);
  assert.equal(resolveJobReportNum({}, index), null);
  assert.equal(resolveJobReportNum({ kind: "pdf" }, index), null);
});

test("showsEvalDuration: the report number is navigation, not a duration claim", () => {
  assert.equal(showsEvalDuration({ kind: "evaluate" }), true);
  assert.equal(showsEvalDuration({ kind: "batch-evaluate" }), true);
  assert.equal(showsEvalDuration({ kind: "pdf" }), false);
  assert.equal(showsEvalDuration({ kind: "research" }), false);
  assert.equal(showsEvalDuration({ kind: "fix-portal" }), false);
  // Records with no kind predate the field — keep their old behaviour.
  assert.equal(showsEvalDuration({}), true);
  assert.equal(showsEvalDuration(null), true);
});
