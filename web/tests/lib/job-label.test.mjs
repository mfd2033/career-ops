// Tests for job-label.mjs — 任务卡标题的「公司 · 岗位」标签（/jobs 列表可读性）。
// 派发时从 pipeline 行带、完成后从报告 Machine Summary 回填；拼不出就不猜。
//
// Run:  node --test tests/lib/job-label.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { jobLabel, reportJobLabel, pipelineUrlLabels, trackerUrlLabels, evaluateDisplayTitle } from "../../src/lib/job-label.mjs";

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

test("jobLabel: 未知雇主 sentinel「?」不算有值，退化到另一边", () => {
  // 评估员拿不到雇主名时 Machine Summary 写 company: "?"（reports/1305 实测），
  // 展示成「? · 岗位」没有信息量——按无值处理，只剩岗位名。
  assert.equal(jobLabel("?", "项目经理（智能硬件）"), "项目经理（智能硬件）");
  assert.equal(jobLabel("？", "项目经理（智能硬件）"), "项目经理（智能硬件）");
  assert.equal(jobLabel("?", "?"), "");
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

// ── trackerUrlLabels ─────────────────────────────────────────────────────────

test("trackerUrlLabels: 归一化 URL 为键，跳过缺字段/空 URL，同键保留首行", () => {
  const map = trackerUrlLabels([
    { url: "https://www.zhipin.com/job_detail/abc.html?securityId=tok&ka=click", company: "蔚来汽车", role: "数据平台工程师" },
    { url: "https://www.zhipin.com/job_detail/abc.html", company: "别的公司", role: "别的岗位" },
    { url: "https://b.com/2", company: "", role: "R" },
    { url: "", company: "C", role: "R" },
    { url: "https://c.com/3" },
  ]);
  assert.equal(map.size, 2);
  // 跟踪参数被剥掉：粘贴带 securityId/ka 的 URL 也能命中同一行
  assert.equal(map.get("https://www.zhipin.com/job_detail/abc.html"), "蔚来汽车 · 数据平台工程师");
  assert.equal(map.get("https://b.com/2"), "R");
});

test("trackerUrlLabels: 非 http(s)/坏 URL 与非数组输入安全", () => {
  assert.equal(trackerUrlLabels([{ url: "javascript:void(0)", company: "X", role: "Y" }]).size, 0);
  assert.equal(trackerUrlLabels(null).size, 0);
  assert.equal(trackerUrlLabels(undefined).size, 0);
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

test("evaluateDisplayTitle: 报告/pipeline 行都缺时，扩展详情页的 company+role 拼成「公司 · 岗位」", () => {
  // 黑名单门禁拦下的评估没有报告可回填，职位名只能来自派发时的扩展 payload。
  assert.equal(evaluateDisplayTitle({ company: "中犇科技", role: "全栈技术经理" }), "中犇科技 · 全栈技术经理");
  // 只有一边时退化为单字段，不编造另一边。
  assert.equal(evaluateDisplayTitle({ company: "中犇科技", role: "" }), "中犇科技");
  assert.equal(evaluateDisplayTitle({ company: "", role: "全栈技术经理" }), "全栈技术经理");
});

test("evaluateDisplayTitle: 报告标签仍优先于扩展传的 company+role", () => {
  assert.equal(
    evaluateDisplayTitle({ reportLabel: "报告落定公司 · 报告落定岗位", company: "扩展公司", role: "扩展岗位" }),
    "报告落定公司 · 报告落定岗位",
  );
});

test("evaluateDisplayTitle: 都拼不出返回空串（调用方保留原兜底形状，不编造）", () => {
  assert.equal(evaluateDisplayTitle({}), "");
  assert.equal(evaluateDisplayTitle({ reportLabel: "", inboxLabel: null, company: undefined }), "");
  assert.equal(evaluateDisplayTitle({ reportLabel: "null", inboxLabel: "n/a" }), "");
  assert.equal(evaluateDisplayTitle(), "");
});