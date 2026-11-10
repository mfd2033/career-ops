// run-titles 纯逻辑单测：/api/runs/history 的「公司 · 岗位」读取端补齐。
//
// 锁三件事：① 只有 kind === "evaluate" 且有报告号的行被改写（批量/体检/PDF 各有
// 自己的标题）；② 取不到标签时原样返回、连引用都不换；③ 标签读取器命中缓存，
// 空结果不缓存（报告可能还没写完）。
//
// Run:  node --test web/tests/lib/run-titles.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichEvaluateTitles, createLabelForNum } from "../../src/lib/run-titles.mjs";

const URL = "https://www.zhipin.com/job_detail/c08d86bf72a6b1410nJ609W_FVdX.html";

const ev = (over = {}) => ({ id: "r1", kind: "evaluate", input: URL, title: `evaluate ${URL}`, reportNum: "1294", ...over });

// ── enrichEvaluateTitles ────────────────────────────────────────────────────

test("enrichEvaluateTitles: 有报告标签时改写标题，其余字段原样", () => {
  const row = ev();
  const [out] = enrichEvaluateTitles([row], () => "上海融达 · 项目经理（医疗软件项目）");
  assert.equal(out.title, "上海融达 · 项目经理（医疗软件项目）");
  assert.equal(out.reportNum, "1294");
  assert.equal(out.input, URL);
  assert.equal(out.kind, "evaluate");
});

test("enrichEvaluateTitles: 标签取不到 / 与现标题相同 → 原样且不换引用", () => {
  const row = ev();
  const same = [row];
  assert.equal(enrichEvaluateTitles(same, () => "")[0], row);
  assert.equal(enrichEvaluateTitles(same, () => "某公司")[0] !== row, true);
  const alreadyNamed = ev({ title: "上海融达 · 项目经理" });
  const list = [alreadyNamed];
  assert.equal(enrichEvaluateTitles(list, () => "上海融达 · 项目经理")[0], alreadyNamed);
});

test("enrichEvaluateTitles: 一个都没改时返回原数组引用", () => {
  const list = [ev()];
  assert.equal(enrichEvaluateTitles(list, () => ""), list);
});

test("enrichEvaluateTitles: 只动 evaluate 且有报告号的行", () => {
  const rows = [
    ev({ id: "batch", kind: "batch-evaluate", title: "批量评估 · 1 项" }),
    ev({ id: "checkup", kind: "checkup", title: "公司体检：视源股份" }),
    ev({ id: "pdf", kind: "pdf", title: "定制简历 PDF · #1083" }),
    ev({ id: "nonum", reportNum: undefined }),
    ev({ id: "nonum2", reportNum: null }),
  ];
  const out = enrichEvaluateTitles(rows, () => "上海融达 · 项目经理");
  assert.deepEqual(out.map((r) => r.id), rows.map((r) => r.id));
  for (let i = 0; i < rows.length; i++) assert.equal(out[i], rows[i], `${rows[i].id} 被改写了`);
});

test("enrichEvaluateTitles: 数字型报告号也能查；脏入参不炸", () => {
  assert.equal(enrichEvaluateTitles([ev({ reportNum: 1294 })], () => "公司 · 岗位")[0].title, "公司 · 岗位");
  assert.deepEqual(enrichEvaluateTitles(null, () => "x"), []);
  assert.deepEqual(enrichEvaluateTitles([null, undefined], () => "x"), [null, undefined]);
});

// ── createLabelForNum ──────────────────────────────────────────────────────

const REPORT = `# Evaluation: 上海融达 — 项目经理

## Machine Summary

\`\`\`yaml
company: "上海融达信息科技有限公司"
role: "项目经理（医疗软件项目）"
\`\`\`
`;

test("createLabelForNum: 按索引读报告并解析「公司 · 岗位」，命中后走缓存不再读盘", () => {
  let reads = 0;
  const labelForNum = createLabelForNum({
    index: new Map([[4321, "4321-acme-2026-11-01.md"]]),
    reportsDir: "C:/reports",
    readText: (file) => {
      reads++;
      assert.equal(file.replace(/\\/g, "/"), "C:/reports/4321-acme-2026-11-01.md");
      return REPORT;
    },
  });
  assert.equal(labelForNum("4321"), "上海融达信息科技有限公司 · 项目经理（医疗软件项目）");
  assert.equal(labelForNum(4321), "上海融达信息科技有限公司 · 项目经理（医疗软件项目）");
  assert.equal(reads, 1, "第二次应命中缓存");
});

test("createLabelForNum: 索引里没有该号 → 空串且不读盘", () => {
  let reads = 0;
  const labelForNum = createLabelForNum({
    index: new Map(),
    reportsDir: "C:/reports",
    readText: () => {
      reads++;
      return REPORT;
    },
  });
  assert.equal(labelForNum("999999"), "");
  assert.equal(reads, 0);
});

test("createLabelForNum: 读盘失败按取不到处理，且不缓存空结果（下次再试）", () => {
  let reads = 0;
  let broken = true;
  const labelForNum = createLabelForNum({
    index: new Map([[5555, "5555-acme.md"]]),
    reportsDir: "C:/reports",
    readText: () => {
      reads++;
      if (broken) throw new Error("ENOENT");
      return REPORT;
    },
  });
  assert.equal(labelForNum("5555"), "");
  broken = false;
  assert.equal(labelForNum("5555"), "上海融达信息科技有限公司 · 项目经理（医疗软件项目）");
  assert.equal(reads, 2, "空结果不缓存，报告写完后能补上");
});

test("createLabelForNum: 报告里没有 Machine Summary → 空串", () => {
  const labelForNum = createLabelForNum({
    index: new Map([[7777, "7777-x.md"]]),
    reportsDir: "C:/reports",
    readText: () => "# Evaluation\n\n没有摘要段。",
  });
  assert.equal(labelForNum("7777"), "");
});

test("createLabelForNum: 非数字报告号安全", () => {
  const labelForNum = createLabelForNum({ index: new Map(), reportsDir: "C:/reports", readText: () => REPORT });
  assert.equal(labelForNum(""), "");
  assert.equal(labelForNum(null), "");
  assert.equal(labelForNum("abc"), "");
});
