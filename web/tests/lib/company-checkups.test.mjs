// Tests for the 公司体检台账 reader contract (CONTEXT.md「公司体检台账」, ADR-0025):
// tracker# is the join key; `?` rows never join (manual backfill only); latest
// checkup per tracker# wins (max date, ties → file order last); the `-`
// no-risk sentinel parses to []; a missing/empty ledger degrades to {}.
//
// Run:  node --test tests/lib/company-checkups.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCheckupLedger, checkupIndex, CHECKUP_RISK_LABELS, suggestsCheckup } from "../../src/lib/company-checkups.mjs";

const TSV = `# tracker#\tdate\tcompany-slug\tcompany\tstar\trisks\thtml\tnote
917\t2026-09-14\thenan-lanhui\t河南蓝辉人力资源\t2.5\tentity-confusion,social-mismatch\treports/checkups/917-henan-lanhui-2026-09-14.html\t终雇主未披露
917\t2026-09-20\thenan-lanhui\t河南蓝辉人力资源\t3.5\t-\treports/checkups/917-henan-lanhui-2026-09-20.html\t复检转好
?\t2026-09-15\tghost-co\t幽灵公司\t1.5\tsocial-zero,scale-mismatch\t-\t参保0人
truncated\t2026-09-16
bad-star\tx\tx\tx\tnot-a-number\tx\tx\tx`;

test("parse: skips header/blank/truncated/bad-star rows", () => {
  const rows = parseCheckupLedger(TSV);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].star, 2.5);
  assert.deepEqual(rows[2].risks, ["social-zero", "scale-mismatch"]);
});

test("parse: `-` risk sentinel → empty array", () => {
  const rows = parseCheckupLedger(TSV);
  assert.deepEqual(rows[1].risks, []);
});

test("index: latest checkup per tracker# (re-check supersedes)", () => {
  const idx = checkupIndex(TSV);
  assert.equal(idx["917"].star, 3.5);
  assert.equal(idx["917"].date, "2026-09-20");
  assert.equal(idx["917"].count, 2);
  assert.deepEqual(idx["917"].history, [
    { date: "2026-09-14", star: 2.5 },
    { date: "2026-09-20", star: 3.5 },
  ]);
  assert.equal(idx["917"].minStar, 2.5);
  assert.equal(idx["917"].maxStar, 3.5);
});

test("index: same-day ties → file order, last wins", () => {
  const idx = checkupIndex(`# h
5\t2026-09-14\ta\tA\t2\t-\t-\t
5\t2026-09-14\ta\tA\t4\ttactics\t-\t重检`);
  assert.equal(idx["5"].star, 4);
});

test("index: `?` (no tracker row) stays its own bucket — joins nothing", () => {
  const idx = checkupIndex(TSV);
  assert.ok(idx["?"]);
  assert.equal(idx["?"].slug, "ghost-co");
  // and it must not bleed into numeric keys
  assert.equal(idx["917"].slug, "henan-lanhui");
});

test("empty/missing ledger → {} (graceful degradation)", () => {
  assert.deepEqual(checkupIndex(null), {});
  assert.deepEqual(checkupIndex(""), {});
  assert.deepEqual(checkupIndex("# only the header\n"), {});
});

test("risk label map covers the writer's closed vocabulary", () => {
  // Writer: lib/log-checkup.mjs RISK_FACTORS (8 factors). If the writer grows,
  // this map (and this test) must grow with it.
  assert.deepEqual(
    Object.keys(CHECKUP_RISK_LABELS).sort(),
    [
      "arbitration",
      "entity-confusion",
      "media-negative",
      "review-negative",
      "scale-mismatch",
      "social-mismatch",
      "social-zero",
      "tactics",
    ],
  );
});

// ── 「建议体检」口径（ADR-0041 决议 2 落地 ADR-0025）────────────────────────

test("suggestsCheckup: score ≥ 4.0 且无体检记录 → 建议", () => {
  assert.equal(suggestsCheckup({ score: 4.0, legitimacy: null, hasCheckup: false }), true);
  assert.equal(suggestsCheckup({ score: 4.7, legitimacy: "High Confidence", hasCheckup: false }), true);
});

test("suggestsCheckup: Block G ⚠（caution/suspicious 系关键词）→ 建议", () => {
  for (const legitimacy of ["Proceed with Caution", "Caution", "Suspicious", "sospechoso", "scam signals", "fake posting"]) {
    assert.equal(suggestsCheckup({ score: 2.5, legitimacy, hasCheckup: false }), true, legitimacy);
  }
});

test("suggestsCheckup: 低分 + Block G 正常/未评估 → 不建议", () => {
  assert.equal(suggestsCheckup({ score: 3.9, legitimacy: "High Confidence", hasCheckup: false }), false);
  assert.equal(suggestsCheckup({ score: 3.5, legitimacy: null, hasCheckup: false }), false);
  assert.equal(suggestsCheckup({ score: null, legitimacy: null, hasCheckup: false }), false);
});

test("suggestsCheckup: 已有体检记录 → 永不建议（角标是「该体检还没检」的正向提示）", () => {
  assert.equal(suggestsCheckup({ score: 4.8, legitimacy: "Suspicious", hasCheckup: true }), false);
});

test("suggestsCheckup: score 4.0 边界恰好算（口径是 ≥ 4.0，闭口）", () => {
  assert.equal(suggestsCheckup({ score: 3.99, legitimacy: null, hasCheckup: false }), false);
});
