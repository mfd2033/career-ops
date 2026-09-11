// Tests for the 评估用时 contract (CONTEXT.md「评估用时」/「评估会话」, ADR-0016):
// duration = latest eval session, report-delivery steps only (extract/liveness/
// eval/report); delayed pdf/answers/tracker are visible but NOT counted;
// orphan rows with no report-delivery step yield duration null; a re-eval
// (new extract) supersedes the older session; a delayed lone pdf must NOT
// mask the real session before it.
//
// Run:  node --test tests/lib/eval-timings.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvalTimings, latestEvalSessions, evalTimingSummary } from "../../src/lib/eval-timings.mjs";

// Mirrors the real data/eval-timings.tsv shapes (reports 252/253/999/703).
const TSV = `# report\tstep\tseconds\tfinished_at
252\textract\t45.2\t2026-09-10T03:09:53.140Z
252\tliveness\t11.0\t2026-09-10T03:10:04.240Z
252\teval\t97.3\t2026-09-10T03:11:41.613Z
252\treport\t89.6\t2026-09-10T03:13:11.402Z
252\tpdf\t79.8\t2026-09-10T03:14:31.373Z
252\tanswers\t0.1\t2026-09-10T03:14:31.672Z
252\ttracker\t19.8\t2026-09-10T03:14:51.622Z
253\textract\t33.5\t2026-09-10T03:17:05.605Z
253\tliveness\t39.0\t2026-09-10T03:17:44.754Z
253\teval\t18.5\t2026-09-10T03:18:03.354Z
253\treport\t63.2\t2026-09-10T03:19:06.636Z
253\tanswers\t0.1\t2026-09-10T03:19:06.896Z
253\ttracker\t18.9\t2026-09-10T03:19:25.927Z
999\tpdf\t114.1\t2026-09-10T06:55:21.560Z
703\teval\t8.4\t2026-09-10T23:00:48.424Z
703\treport\t37.4\t2026-09-10T23:01:25.941Z
703\ttracker\t0.2\t2026-09-10T23:01:39.996Z`;

test("parse: skips header comment, keeps numeric rows", () => {
  const rows = parseEvalTimings(TSV);
  assert.equal(rows.length, 17);
  assert.deepEqual(rows[0], { report: "252", step: "extract", seconds: 45.2, finishedAt: "2026-09-10T03:09:53.140Z" });
});

test("parse: tolerant of blank/malformed lines", () => {
  const rows = parseEvalTimings("\n# c\ngarbage\n300\teval\t5\t2026-01-01T00:00:00Z\n");
  assert.deepEqual(rows, [{ report: "300", step: "eval", seconds: 5, finishedAt: "2026-01-01T00:00:00Z" }]);
});

test("duration counts report-delivery steps only (252 → 243.1s)", () => {
  const s = evalTimingSummary(TSV);
  assert.equal(s["252"].duration, 243.1);
  // full session incl. delayed pdf/answers/tracker stays visible
  assert.deepEqual(s["252"].steps.map((x) => x.step), ["extract", "liveness", "eval", "report", "pdf", "answers", "tracker"]);
});

test("session without pdf (253) counts the same four steps → 154.2s", () => {
  const s = evalTimingSummary(TSV);
  assert.equal(s["253"].duration, 154.2);
});

test("orphan lone pdf (999) → duration null, empty counted session", () => {
  const s = evalTimingSummary(TSV);
  assert.equal(s["999"].duration, null);
});

test("no-start-marker legacy session (703) sums what exists → 45.8s", () => {
  const s = evalTimingSummary(TSV);
  assert.equal(s["703"].duration, 45.8);
});

test("re-eval (new extract) supersedes the older session", () => {
  const rows = parseEvalTimings(
    ["1\textract\t10\t2026-01-01T00:00:00Z", "1\teval\t20\t2026-01-01T00:01:00Z", "1\textract\t100\t2026-01-02T00:00:00Z", "1\teval\t200\t2026-01-02T00:02:00Z"].join("\n"),
  );
  const s = latestEvalSessions(rows);
  assert.equal(s.get("1").duration, 300);
  assert.equal(s.get("1").finishedAt, "2026-01-02T00:02:00Z");
});

test("delayed lone pdf AFTER a finished session does not mask it", () => {
  const rows = parseEvalTimings(
    ["5\textract\t10\t2026-01-01T00:00:00Z", "5\teval\t20\t2026-01-01T00:01:00Z", "5\treport\t30\t2026-01-01T00:02:00Z", "5\tpdf\t500\t2026-01-01T09:00:00Z"].join("\n"),
  );
  const s = latestEvalSessions(rows);
  assert.equal(s.get("5").duration, 60);
  // the delayed pdf is still listed in the session breakdown
  assert.ok(s.get("5").steps.some((x) => x.step === "pdf"));
});

test("missing file / empty text → empty map", () => {
  assert.deepEqual(evalTimingSummary(""), {});
  assert.deepEqual(evalTimingSummary(null), {});
});
