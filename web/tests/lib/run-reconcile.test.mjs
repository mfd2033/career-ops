// Tests for the single-run pipeline.md reconciliation helper (ADR-0051 决议 9/10).
//
// The batch orchestrator owns `reportNum` up front, so it can tell
// reconcile-pipeline.mjs exactly which (num, url) pair it just scored. A single
// /api/run evaluate does not: the WORKER reserves its own number mid-run, and the
// route only learns it from what landed in reports/. These assertions pin the one
// place that derivation happens — and, just as importantly, the cases where it
// must REFUSE to guess.
//
// Run:  node --test tests/lib/run-reconcile.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRunReportNum, buildReconcileArgs } from "../../src/lib/run-reconcile.mjs";

const URL = "https://www.liepin.com/job/1998394056.shtml";

test("deriveRunReportNum: the one new completed report is this run's number", () => {
  const n = deriveRunReportNum({
    beforeEntries: ["040-acme-2026-09-22.md", "041-RESERVED.md"],
    afterEntries: ["040-acme-2026-09-22.md", "042-someco-2026-09-23.md"],
  });
  assert.equal(n, 42);
});

test("deriveRunReportNum: a sentinel replaced by its report resolves to that number", () => {
  // The canonical single-run shape: 2a writes 042-RESERVED.md, 2b replaces it with
  // the real report. The sentinel is not a completed report and must never be the
  // answer on its own.
  const n = deriveRunReportNum({
    beforeEntries: [],
    afterEntries: ["042-RESERVED.md", "042-someco-2026-09-23.md"],
  });
  assert.equal(n, 42);
});

test("deriveRunReportNum: two new reports is ambiguous, not a coin flip", () => {
  // The concurrency pool lets another evaluate run land its report inside this
  // run's window. Moving a pipeline row under the WRONG report number is worse
  // than leaving it for the periodic `--from-tracker` self-heal.
  const n = deriveRunReportNum({
    beforeEntries: [],
    afterEntries: ["041-a-2026-09-23.md", "042-b-2026-09-23.md"],
  });
  assert.equal(n, null);
});

test("deriveRunReportNum: no new report yields null", () => {
  assert.equal(deriveRunReportNum({ beforeEntries: ["040-a.md"], afterEntries: ["040-a.md"] }), null);
  assert.equal(deriveRunReportNum({ beforeEntries: [], afterEntries: [] }), null);
});

test("deriveRunReportNum: ignores non-report names and a sentinel-only delta", () => {
  // A bare `1001-taken.md` IS a real report name in the wild (unpadded, no date),
  // so the parse must not require a trailing date — but README.md, checkup HTML and
  // a lone reservation sentinel are not this run's report.
  assert.equal(deriveRunReportNum({ beforeEntries: [], afterEntries: ["1001-taken.md"] }), 1001);
  const ignored = deriveRunReportNum({
    beforeEntries: [],
    afterEntries: ["README.md", "043-RESERVED.md", "checkups", "notes.txt"],
  });
  assert.equal(ignored, null);
});

test("buildReconcileArgs: an evaluate run with a URL and a number yields one entry", () => {
  assert.deepEqual(buildReconcileArgs({ kind: "evaluate", input: URL, num: 42 }), ["--entry", `42|${URL}`]);
});

test("buildReconcileArgs: nothing to reconcile without a number", () => {
  for (const num of [null, undefined]) {
    assert.equal(buildReconcileArgs({ kind: "evaluate", input: URL, num }), null);
  }
});

test("buildReconcileArgs: a non-URL input is not an inbox entry", () => {
  // pdf takes a bare report number, checkup a tracker row number, fix-portal a
  // company name — reconciling any of them would move a row on a bogus key.
  assert.equal(buildReconcileArgs({ kind: "evaluate", input: "042", num: 42 }), null);
  assert.equal(buildReconcileArgs({ kind: "pdf", input: URL, num: 42 }), null);
  assert.equal(buildReconcileArgs({ kind: "checkup", input: URL, num: 42 }), null);
});
