// Tests for pipeline-sections.mjs — the ONE definition of "which lines of
// pipeline.md are the Pending chapter".
//
// Regression for 2026-09-14: the web inbox checkbox-scanned the WHOLE file, so
// user scratch chapters (`## 非郑州`, `## 暂存`) leaked 49 rows into the triage
// view — 25 of which had already been scored and folded into the tracker.
//
// Run:  node --test tests/lib/pipeline-sections.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingSectionLines, PENDING_SECTION_RE } from "../../src/lib/pipeline-sections.mjs";

const DOC = [
  "# Pipeline — Pending URLs",
  "",
  "## Pending",
  "",
  "- [ ] https://jobs.example.com/1 | Acme | Engineer",
  "- [x] https://jobs.example.com/2 | Beta | Backend",
  "",
  "## Processed",
  "",
  "- [x] [801](reports/801.md) | https://jobs.example.com/3 | Acme | Engineer | 4/5 | PDF ❌",
  "",
  "## 非郑州",
  "",
  "- [ ] https://jobs.example.com/other | Gamma | PM",
  "",
  "## 暂存",
  "",
  "- [ ] https://jobs.example.com/stash | Delta | EM",
  "",
].join("\n");

test("only the Pending chapter is returned", () => {
  const lines = pendingSectionLines(DOC).filter((l) => l.trim());
  assert.deepEqual(lines, [
    "- [ ] https://jobs.example.com/1 | Acme | Engineer",
    "- [x] https://jobs.example.com/2 | Beta | Backend",
  ]);
});

test("user scratch chapters (非郑州 / 暂存) never leak into the inbox", () => {
  const text = pendingSectionLines(DOC).join("\n");
  assert.ok(!text.includes("jobs.example.com/other"), "非郑州 chapter leaked");
  assert.ok(!text.includes("jobs.example.com/stash"), "暂存 chapter leaked");
});

test("checked [x] rows inside Pending stay readable (pipeline mode folds them)", () => {
  const text = pendingSectionLines(DOC).join("\n");
  assert.ok(text.includes("jobs.example.com/2"), "checked Pending row was dropped");
});

test("Processed rows are excluded — they are already reconciled, not pending", () => {
  const text = pendingSectionLines(DOC).join("\n");
  assert.ok(!text.includes("reports/801.md"), "Processed row leaked");
});

test("legacy flat file without a Pending header stays fully readable", () => {
  const flat = "- [ ] https://jobs.example.com/1 | Acme | Engineer\n- [ ] https://jobs.example.com/2 | Beta | Dev\n";
  const rows = pendingSectionLines(flat).filter((l) => l.trim());
  assert.equal(rows.length, 2, "flat file must not come back empty");
});

test("legacy Spanish header (## Pendientes) is recognized, like scan.mjs", () => {
  const doc = ["## Pendientes", "", "- [ ] https://jobs.example.com/1 | Acme | Engineer", "", "## Procesadas"].join("\n");
  assert.ok(pendingSectionLines(doc).join("\n").includes("jobs.example.com/1"));
});

test("CRLF line endings are tolerated", () => {
  const doc = "## Pending\r\n\r\n- [ ] https://jobs.example.com/1 | Acme | Engineer\r\n\r\n## Processed\r\n";
  const text = pendingSectionLines(doc).join("\n");
  assert.ok(text.includes("jobs.example.com/1"));
  assert.ok(!text.includes("## Processed"));
});

test("Pending as the last section (no trailing header) reads to end of file", () => {
  const doc = "## Pending\n\n- [ ] https://jobs.example.com/1 | Acme | Engineer\n";
  assert.equal(pendingSectionLines(doc).filter((l) => l.trim()).length, 1);
});

test("a Pending header with surrounding whitespace still matches", () => {
  assert.ok(PENDING_SECTION_RE.test("##  Pending  "));
  assert.ok(PENDING_SECTION_RE.test("## Pendientes"));
  assert.ok(!PENDING_SECTION_RE.test("### Pending"), "h3 must not count as a section header");
  assert.ok(!PENDING_SECTION_RE.test("## Pendingish"));
});
