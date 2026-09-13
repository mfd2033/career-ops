// Regression test for parse-report.mjs — header field extraction that must keep
// accepting BOTH header shapes reporters write:
//   • `**URL:** https://…`            (line-start, classic writers)
//   • `> **URL:** https://…`          (blockquote stem, some batch/locale writers)
// The blockquote case broke the posting URL for /api/report-status (→ no BOSS
// badge) and the report page's ApplyButton (→ "没有申请链接"), #131/#132.
//
// It also pins `**Via:**`, which the report page reads to name the poster on a
// `?` (unknown-employer) row when the policy is "agency" — a key missing from
// FIELD_KEYS made that fallback dead code for every report, silently, since an
// absent label just returns undefined.
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

test("extracts `**Via:**` so a `?` tracker row can fall back to the agency name", () => {
  // Real header from reports/836-confidential-yunjing-renli-2026-09-13.md: an
  // agency-mediated posting whose end employer is hidden, so the tracker's
  // Company cell is the `?` sentinel (modes/oferta.md §2) and the ONLY place the
  // agency name exists is this header line.
  //
  // report-view.tsx resolves the header/company label for a `?` row via
  // `field("Via")` when the unknown-employer policy is "agency". FIELD_KEYS had
  // no `via` key, so that lookup returned undefined for EVERY report, the
  // `&& viaValue` guard short-circuited, and the label stayed "?" — the report
  // "显示代招方" policy could never take effect (586/849 reports carry the
  // header, so the fallback was dead code, not an edge case).
  const md = [
    "# Evaluation: 河南某中型生活服务(O2O)公司 — 高级技术经理",
    "",
    "**Date:** 2026-09-13",
    "**URL:** https://www.zhipin.com/job_detail/1a689d20bca73c7f0nd83d-5FVFS.html",
    "**Via:** 云憬人力·猎头顾问（猎头中介）",
    "**Archetype:** 技术经理 + 软件项目经理（双轴）",
    "**Score:** 3.5/5",
    "**Legitimacy:** Proceed with Caution",
    "**PDF:** pending",
    "---",
    "",
    "## Machine Summary",
  ].join("\n");
  const { fields } = parseReport(md);
  assert.equal(
    fields.find((f) => f.label === "Via")?.value,
    "云憬人力·猎头顾问（猎头中介）",
    "`**Via:**` must reach `fields` — the `?` → agency fallback in report-view.tsx reads exactly this label",
  );
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