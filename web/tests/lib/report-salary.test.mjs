// Tests for 报告薪资 (ADR-0037) — the tracker table's salary column reads the
// report's Machine Summary `advertised_comp` and normalizes it into a monthly-K
// range. The normalization layer exists because parseSalaryText (shared with the
// explore page / inbox, so NOT modified here) chokes on the currency suffixes
// reports actually contain (`10-15K CNY/月`) and because the board-口径 must not
// apply inside a report (a bare 万 in a report is monthly, not 猎聘's annual).
//
// Run:  node --test tests/lib/report-salary.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAdvertisedComp, parseReportSalary, formatSalaryRange, salaryMedian } from "../../src/lib/report-salary.mjs";

const REPORT = `# Evaluation: Acme — Senior Engineer

**Date:** 2026-09-15
**URL:** https://www.zhaopin.com/jobdetail/CC123.htm
**Score:** 4.0/5

---

## Machine Summary

\`\`\`yaml
report_num: 918
company: Acme
advertised_comp: "8000-15000元"
score: 4.0
\`\`\`

---

## D) Comp and Demand

| 来源 | 范围 |
|------|------|
| 招聘平台 JD | 8000-15000 元/月 |
`;

// ── extractAdvertisedComp ────────────────────────────────────────────────────

test("extractAdvertisedComp: 取 Machine Summary 的字段原文并去引号", () => {
  assert.equal(extractAdvertisedComp(REPORT), "8000-15000元");
});

test("extractAdvertisedComp: 容忍缩进与无引号写法", () => {
  assert.equal(extractAdvertisedComp("```yaml\n  advertised_comp: 10-15K CNY/月\n```"), "10-15K CNY/月");
  assert.equal(extractAdvertisedComp("advertised_comp: '25-55k·15薪'"), "25-55k·15薪");
});

test("extractAdvertisedComp: 缺字段 / null / ~ / 空串 → \"\"（无可悬停原文）", () => {
  assert.equal(extractAdvertisedComp("# no machine summary here"), "");
  assert.equal(extractAdvertisedComp("advertised_comp: null"), "");
  assert.equal(extractAdvertisedComp("advertised_comp: ~"), "");
  assert.equal(extractAdvertisedComp("advertised_comp: \"\""), "");
  assert.equal(extractAdvertisedComp(""), "");
  assert.equal(extractAdvertisedComp(undefined), "");
});

test("extractAdvertisedComp: 第一处（Machine Summary）胜出，D 段不覆盖", () => {
  const md = "advertised_comp: 10-15K\n\n## D) Comp and Demand\nadvertised_comp: 99-99K\n";
  assert.equal(extractAdvertisedComp(md), "10-15K");
});

test("extractAdvertisedComp: ADR-0037 之前的旧字段名兼容（同一事实）", () => {
  // salary_advertised（真实语料 #640：JD 标注 8000-10000元/月，与候选人目标区分）
  assert.equal(extractAdvertisedComp("salary_advertised: \"8000-10000元/月\"\nsalary_candidate_target: \"25000-30000元/月\""), "8000-10000元/月");
  // comp_advertised（真实语料 #401，常配 comp_currency / comp_period）
  assert.equal(extractAdvertisedComp("comp_advertised: 8-13K\ncomp_currency: CNY\ncomp_period: monthly"), "8-13K");
  // salary_advertised（真实语料 #428，·月 后缀）
  assert.equal(extractAdvertisedComp("salary_advertised: \"12-20K·月\""), "12-20K·月");
});

test("extractAdvertisedComp: 新名优先于旧名（双字段并存时）", () => {
  assert.equal(extractAdvertisedComp("advertised_comp: 10-15K\nsalary_advertised: 99-99K"), "10-15K");
});

test("extractAdvertisedComp: 旧名不误吃候选人目标字段", () => {
  assert.equal(extractAdvertisedComp("salary_target: 25000-30000元/月\nsalary_candidate_target: 25000-30000元/月"), "");
  assert.equal(extractAdvertisedComp("comp_target: 25-30K"), "");
});

// ── parseReportSalary：可解析的报告串形态（均取自真实语料）───────────────

test("parseReportSalary: 元/月 形态 ÷1000", () => {
  assert.deepEqual(parseReportSalary("8000-15000元"), { text: "8000-15000元", range: { minK: 8, maxK: 15, medianK: 11.5 } });
});

test("parseReportSalary: CNY / RMB 币种后缀视同「元」——直解会整体失败的卡点", () => {
  assert.deepEqual(parseReportSalary("10-15K CNY/月")?.range, { minK: 10, maxK: 15, medianK: 12.5 });
  assert.deepEqual(parseReportSalary("8-12K CNY/month")?.range, { minK: 8, maxK: 12, medianK: 10 });
  assert.deepEqual(parseReportSalary("10000-20000 CNY/月")?.range, { minK: 10, maxK: 20, medianK: 15 });
  assert.deepEqual(parseReportSalary("20-40K RMB/月")?.range, { minK: 20, maxK: 40, medianK: 30 });
});

test("parseReportSalary: 裸「万」= 月薪（不得按猎聘的 ÷12 口径）", () => {
  assert.deepEqual(parseReportSalary("1.5–2.5万")?.range, { minK: 15, maxK: 25, medianK: 20 });
  assert.deepEqual(parseReportSalary("1-2万 CNY/月")?.range, { minK: 10, maxK: 20, medianK: 15 });
  assert.deepEqual(parseReportSalary("1.2-2万·14薪")?.range, { minK: 12, maxK: 20, medianK: 16 });
});

test("parseReportSalary: 显式年薪才 ÷12", () => {
  assert.deepEqual(parseReportSalary("30万/年（未拆分固定与绩效）")?.range, { minK: 25, maxK: 25, medianK: 25 });
});

test("parseReportSalary: 去括号补充说明，尾注里的数字不参与", () => {
  assert.deepEqual(parseReportSalary("15-30K CNY（底薪5000-11000 + 提成 + 季度奖 + 年终奖）")?.range, {
    minK: 15,
    maxK: 30,
    medianK: 22.5,
  });
  assert.deepEqual(parseReportSalary("20-30k·14薪（职位列表显示，非JD正文）")?.range, { minK: 20, maxK: 30, medianK: 25 });
});

test("parseReportSalary: ·N薪 不影响月薪区间", () => {
  assert.deepEqual(parseReportSalary("10-15K·13薪")?.range, { minK: 10, maxK: 15, medianK: 12.5 });
  assert.deepEqual(parseReportSalary("25-55k·15薪")?.range, { minK: 25, maxK: 55, medianK: 40 });
});

test("parseReportSalary: 单值区间 minK === maxK", () => {
  assert.deepEqual(parseReportSalary("30K")?.range, { minK: 30, maxK: 30, medianK: 30 });
  assert.deepEqual(parseReportSalary("6.5-8.5K")?.range, { minK: 6.5, maxK: 8.5, medianK: 7.5 });
});

// ── parseReportSalary：无值 / 解不出的形态 ────────────────────────────────

test("parseReportSalary: 字段缺失或为 null/~ → null（连原文都没有）", () => {
  assert.equal(parseReportSalary(""), null);
  assert.equal(parseReportSalary(null), null);
  assert.equal(parseReportSalary(undefined), null);
});

test("parseReportSalary: 明确未披露 → 原文保留，range null", () => {
  assert.deepEqual(parseReportSalary("not stated"), { text: "not stated", range: null });
  assert.deepEqual(parseReportSalary("未公开"), { text: "未公开", range: null });
  assert.deepEqual(parseReportSalary("未标注（猎聘页面未显示薪资范围）"), { text: "未标注（猎聘页面未显示薪资范围）", range: null });
});

test("parseReportSalary: 非人民币一律不解析（ADR-0037 决议 3）", () => {
  const jpy = "25万~55万日元/月（约1.2万~2.6万CNY）";
  assert.deepEqual(parseReportSalary(jpy), { text: jpy, range: null });
  assert.equal(parseReportSalary("20-30K USD/月")?.range, null);
});

test("parseReportSalary: 有数字但无区间的散文 → range null（原文仍可悬停）", () => {
  assert.deepEqual(parseReportSalary("底薪8100起，综合薪资20000+"), { text: "底薪8100起，综合薪资20000+", range: null });
  assert.equal(parseReportSalary("有竞争力的薪资 + 项目奖金（未披露具体数字）")?.range, null);
});

// ── formatSalaryRange ───────────────────────────────────────────────────────

test("formatSalaryRange: 区间 / 单值 / 小数", () => {
  assert.equal(formatSalaryRange({ minK: 10, maxK: 15 }), "10-15K");
  assert.equal(formatSalaryRange({ minK: 30, maxK: 30 }), "30K");
  assert.equal(formatSalaryRange({ minK: 6.5, maxK: 8.5 }), "6.5-8.5K");
  assert.equal(formatSalaryRange({ minK: 11.5, maxK: 11.5 }), "11.5K");
  assert.equal(formatSalaryRange(null), "");
  assert.equal(formatSalaryRange(undefined), "");
});

// ── salaryMedian：排序取值（未披露 → null，由比较器负责恒沉底）────────────

test("salaryMedian: 取中位值；未披露/无报告/老行无字段 → null", () => {
  assert.equal(salaryMedian({ reportSalary: { text: "x", range: { minK: 10, maxK: 20, medianK: 15 } } }), 15);
  assert.equal(salaryMedian({ reportSalary: { text: "not stated", range: null } }), null);
  assert.equal(salaryMedian({ reportSalary: null }), null);
  assert.equal(salaryMedian({}), null);
  assert.equal(salaryMedian(undefined), null);
});
