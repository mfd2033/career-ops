// Tests for job-label.mjs — 任务卡标题的「公司 · 岗位」标签（/jobs 列表可读性）。
// 派发时从 pipeline 行带、完成后从报告 Machine Summary 回填；拼不出就不猜。
//
// Run:  node --test tests/lib/job-label.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { jobLabel, reportJobLabel, pipelineUrlLabels, evaluateDisplayTitle } from "../../src/lib/job-label.mjs";

// ── jobLabel ─────────────────────────────────────────────────────────────────

test("jobLabel: 公司 + 岗位 → 「公司 · 岗位」", () => {
  assert.equal(jobLabel("熙牛医疗", "大数据项目经理（郑州）"), "熙牛医疗 · 大数据项目经理（郑州）");
});

test("jobLabel: 缺一退化，全缺为空", () => {
  assert.equal(jobLabel("Acme", ""), "Acme");
  assert.equal(jobLabel("", "Engineer"), "Engineer");
  assert.equal(jobLabel(null, undefined), "");
});

test("jobLabel: 去 YAML 引号与占位值", () => {
  assert.equal(jobLabel('"Acme"', "'Engineer'"), "Acme · Engineer");
  assert.equal(jobLabel("null", "~"), "");
  assert.equal(jobLabel(" n/a ", "none"), "");
});

// ── reportJobLabel ───────────────────────────────────────────────────────────

const REPORT = `# Evaluation: Acme — Senior Engineer

**URL:** https://www.zhipin.com/job_detail/abc.html
**Score:** 4.0/5

---

## Machine Summary

\`\`\`yaml
report_num: 918
company: "熙牛医疗"
role: "大数据项目经理（郑州）"
score: 4.0
\`\`\`

---

## D) Comp and Demand
`;

test("reportJobLabel: 解析 Machine Summary 的 company/role", () => {
  assert.equal(reportJobLabel(REPORT), "熙牛医疗 · 大数据项目经理（郑州）");
});

test("reportJobLabel: 无 Machine Summary 段返回空", () => {
  assert.equal(reportJobLabel("# Evaluation\n\n没有摘要段。"), "");
});

test("reportJobLabel: 只在 Machine Summary 段内匹配，正文的 company:/role: 不误取", () => {
  const md = `# Eval

正文误提 company: 骗子
role: 也误

## Machine Summary

\`\`\`yaml
company: "真公司"
role: "真岗位"
\`\`\`
`;
  assert.equal(reportJobLabel(md), "真公司 · 真岗位");
});

test("reportJobLabel: 空 / null 输入安全", () => {
  assert.equal(reportJobLabel(""), "");
  assert.equal(reportJobLabel(null), "");
});

// ── pipelineUrlLabels ────────────────────────────────────────────────────────

test("pipelineUrlLabels: URL → 标签，跳过缺字段/空 URL，同 URL 保留首条", () => {
  const map = pipelineUrlLabels([
    { url: "https://a.com/1", company: "A", role: "R1" },
    { url: "https://a.com/1", company: "A2", role: "R2" },
    { url: "https://b.com/2", company: "", role: "R" },
    { url: "", company: "C", role: "R" },
    { url: "https://c.com/3" },
  ]);
  assert.equal(map.size, 2);
  assert.equal(map.get("https://a.com/1"), "A · R1");
  assert.equal(map.get("https://b.com/2"), "R");
});

test("pipelineUrlLabels: 非数组输入安全", () => {
  assert.equal(pipelineUrlLabels(null).size, 0);
  assert.equal(pipelineUrlLabels(undefined).size, 0);
});

// ── evaluateDisplayTitle ────────────────────────────────────────────────────

test("evaluateDisplayTitle: 报告标签最权威，其次 pipeline 行，最后才是雇主名", () => {
  assert.equal(
    evaluateDisplayTitle({
      reportLabel: "上海融达信息科技有限公司 · 项目经理（医疗软件项目）",
      inboxLabel: "上海融达 · 项目经理",
      company: "上海融达信息科技有限公司",
    }),
    "上海融达信息科技有限公司 · 项目经理（医疗软件项目）",
  );
  assert.equal(evaluateDisplayTitle({ inboxLabel: "熙牛医疗 · 大数据项目经理", company: "熙牛医疗" }), "熙牛医疗 · 大数据项目经理");
  assert.equal(evaluateDisplayTitle({ company: "熙牛医疗" }), "熙牛医疗");
});

test("evaluateDisplayTitle: 都拼不出返回空串（调用方保留原兜底形状，不编造）", () => {
  assert.equal(evaluateDisplayTitle({}), "");
  assert.equal(evaluateDisplayTitle({ reportLabel: "", inboxLabel: null, company: undefined }), "");
  assert.equal(evaluateDisplayTitle({ reportLabel: "null", inboxLabel: "n/a" }), "");
  assert.equal(evaluateDisplayTitle(), "");
});