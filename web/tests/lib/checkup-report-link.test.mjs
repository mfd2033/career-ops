// Run:  node --test tests/lib/checkup-report-link.test.mjs
//
// Locks the checkup card's report entry: which worker qualifies, and that a
// failed run never gets an entry pointing at a report it did not write.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkupReportHref, checkupReportNum } from "../../src/lib/checkup-report-link.mjs";

test("checkupReportNum: only a DONE checkup run has a report of its own", () => {
  assert.equal(checkupReportNum({ kind: "checkup", input: "1360", status: "done" }), "1360");
  // 失败/中断：本次没有产物，不给入口（旧报告不能冒充本次结果）。
  assert.equal(checkupReportNum({ kind: "checkup", input: "1360", status: "error" }), null);
  assert.equal(checkupReportNum({ kind: "checkup", input: "1360", status: "running" }), null);
  assert.equal(checkupReportNum({ kind: "checkup", input: "1360", status: "queued" }), null);
});

test("checkupReportNum: only the checkup kind — every other kind's input means something else", () => {
  assert.equal(checkupReportNum({ kind: "evaluate", input: "1360", status: "done" }), null);
  assert.equal(checkupReportNum({ kind: "batch-checkup", input: "#1360 +3", status: "done" }), null);
  assert.equal(checkupReportNum({ kind: "pdf", input: "1360", status: "done" }), null);
  assert.equal(checkupReportNum({ kind: "fix-portal", input: "1360", status: "done" }), null);
});

test("checkupReportNum: the tracker# must be a bare number", () => {
  assert.equal(checkupReportNum({ kind: "checkup", input: " 1360 ", status: "done" }), "1360");
  assert.equal(checkupReportNum({ kind: "checkup", input: "#1360", status: "done" }), null);
  assert.equal(checkupReportNum({ kind: "checkup", input: "中玑信拓", status: "done" }), null);
  assert.equal(checkupReportNum({ kind: "checkup", status: "done" }), null);
});

test("checkupReportNum: nothing to resolve → null, never a guess", () => {
  assert.equal(checkupReportNum(null), null);
  assert.equal(checkupReportNum({}), null);
});

test("checkupReportHref: the local HTML route, and no link for a malformed number", () => {
  assert.equal(checkupReportHref("1360"), "/api/checkup-report?n=1360");
  assert.equal(checkupReportHref(1360), "/api/checkup-report?n=1360");
  assert.equal(checkupReportHref(" 1360 "), "/api/checkup-report?n=1360");
  assert.equal(checkupReportHref("#1360"), null);
  assert.equal(checkupReportHref("../../etc/passwd"), null);
  assert.equal(checkupReportHref(""), null);
  assert.equal(checkupReportHref(null), null);
});