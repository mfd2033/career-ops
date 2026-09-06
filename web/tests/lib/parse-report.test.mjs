// Regression test for parse-report.mjs — header field extraction that must keep
// accepting BOTH header shapes reporters write:
//   • `**URL:** https://…`            (line-start, classic writers)
//   • `> **URL:** https://…`          (blockquote stem, some batch/locale writers)
// The blockquote case broke the posting URL for /api/report-status (→ no BOSS
// badge) and the report page's ApplyButton (→ "没有申请链接"), #131/#132.
//
// Run: node --test tests/lib/parse-report.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReport } from "../../src/lib/parse-report.mjs";

test("parses classic line-start `**Label:** value` header", () => {
  const md = [
    "# Evaluation: Example Co — PM",
    "**Date:** 2026-09-01",
    "**URL:** https://www.zhipin.com/job_detail/abc123.html",
    "**Archetype:** Transformation",
    "**Legitimacy:** High Confidence",
    "---",
    "body here",
  ].join("\n");
  const { title, fields, legitimacy, body } = parseReport(md);
  assert.equal(title, "Example Co — PM");
  assert.equal(fields.find((f) => f.label === "URL").value, "https://www.zhipin.com/job_detail/abc123.html");
  assert.equal(fields.find((f) => f.label === "Date").value, "2026-09-01");
  assert.equal(fields.find((f) => f.label === "Archetype").value, "Transformation");
  assert.equal(legitimacy, "High Confidence");
  assert.equal(body, "body here");
});

test("parses blockquote-prefixed header (`> **Label:** value`) — #131/#132", () => {
  const md = [
    "# Report 132 — 蜜雪冰城 | IT项目经理",
    "> **URL:** https://www.zhipin.com/job_detail/46fc8f31130d0b0e0nJy29y0EFtW.html",
    "> **Legitimacy:** Proceed with Caution",
    "> **Verification:** unconfirmed (batch mode)",
    "> **Date:** 2026-09-05",
    "> **Archetype:** 软件项目经理",
    "---",
    "",
    "## Block A — Role Summary",
    "content",
  ].join("\n");
  const { fields, legitimacy, body } = parseReport(md);
  // If the `>` stem isn't stripped, URL (and Date/Archetype/Legitimacy) vanish —
  // the exact bug that disabled the apply button and dropped the BOSS badge.
  assert.equal(fields.find((f) => f.label === "URL").value, "https://www.zhipin.com/job_detail/46fc8f31130d0b0e0nJy29y0EFtW.html");
  assert.equal(fields.find((f) => f.label === "Date").value, "2026-09-05");
  assert.equal(fields.find((f) => f.label === "Archetype").value, "软件项目经理");
  assert.equal(legitimacy, "Proceed with Caution");
  assert.ok(body.includes("Block A"), "body must exclude the blockquote header");
});