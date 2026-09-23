// ledger-display 纯逻辑单测（ADR-0051 后果补丁）：ledger-only 行的可读标题。
//
// 锁两件事：① 只改写服务端 recordEnd 的兜底形状 `${kind} ${input}`，别的标题
// 一律原样（批量「批量评估 · N 项」、体检「公司体检：X」不能被派生覆盖）；
// ② 派生只用记录自带的 kind/input，不发明公司名/职位名。
//
// Run:  node --test web/tests/lib/ledger-display.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { ledgerCardFields } from "../../src/lib/ledger-display.mjs";

/** 真实 i18n 形状的最小替身：键 → 中文标签，带 {company} 插值。 */
const t = (k, p) => {
  const map = {
    "jobs.evaluateTitle": "评估",
    "jobs.researchTitle": "研究",
    "jobs.cvPdfTitle": `定制简历 PDF · ${p?.company ?? ""}`,
    "jobs.fixPortalTitle": `修复 · ${p?.company ?? ""}`,
  };
  return map[k] ?? k;
};

const URL = "https://www.zhipin.com/job_detail/c08d86bf72a6b1410nJ609W_FVdX.html";

test("evaluate 的裸标题派生成可读标题 + 域名锚点 + 管道页", () => {
  const f = ledgerCardFields({ kind: "evaluate", input: URL, title: `evaluate ${URL}`, t });
  assert.deepEqual(f, { title: "评估", page: "/pipeline", subtitle: "zhipin.com" });
});

test("http（非 https）与带 tracking 参数的 URL 都取到域名", () => {
  assert.equal(ledgerCardFields({ kind: "evaluate", input: "http://www.liepin.com/job/1984129495.shtml?skId=x", title: "evaluate http://www.liepin.com/job/1984129495.shtml?skId=x", t }).subtitle, "liepin.com");
  assert.equal(ledgerCardFields({ kind: "evaluate", input: "https://zhaopin.meituan.com/web/position/detail?jobUnionId=1", title: "evaluate https://zhaopin.meituan.com/web/position/detail?jobUnionId=1", t }).subtitle, "zhaopin.meituan.com");
});

test("非 URL 的 evaluate input（异常记录）不编造域名副标题", () => {
  const f = ledgerCardFields({ kind: "evaluate", input: "not-a-url", title: "evaluate not-a-url", t });
  assert.equal(f.title, "评估");
  assert.equal(f.subtitle, undefined);
});

test("pdf 用裸报告号填模板，但落地页不由静态表瞎补", () => {
  const f = ledgerCardFields({ kind: "pdf", input: "1083", title: "pdf 1083", t });
  assert.equal(f.title, "定制简历 PDF · #1083");
  assert.equal(f.page, undefined, "pdf 的落地页按 input 走，不由静态表猜");
});

test("fix-portal 的 input 就是公司名，直接进模板", () => {
  assert.equal(ledgerCardFields({ kind: "fix-portal", input: "Acme Corp", title: "fix-portal Acme Corp", t }).title, "修复 · Acme Corp");
});

test("已有可读标题的行一字不改（批量 / 体检 / 任何非兜底形状）", () => {
  for (const [kind, title] of [
    ["batch-evaluate", "批量评估 · 1 项"],
    ["checkup", "公司体检：视源股份"],
    ["evaluate", "评估"],
  ]) {
    const f = ledgerCardFields({ kind, input: "whatever", title, t });
    assert.deepEqual(f, { title, page: undefined }, `${kind} 的标题被派生覆盖了`);
  }
});

test("没教过的 kind 原样显示，不套「评估」标签", () => {
  const f = ledgerCardFields({ kind: "some-future-kind", input: "x", title: "some-future-kind x", t });
  assert.equal(f.title, "some-future-kind x");
  assert.equal(f.subtitle, undefined);
});

test("服务端已写 page 时不被覆盖（体检行的 /pipeline/{n} 归它自己）", () => {
  const f = ledgerCardFields({ kind: "evaluate", input: URL, title: `evaluate ${URL}`, page: "/pipeline/9", t });
  assert.equal(f.page, "/pipeline/9");
});

test("缺 t（未注入 i18n）时不抛错，键名兜底而不是空串", () => {
  const f = ledgerCardFields({ kind: "evaluate", input: URL, title: `evaluate ${URL}` });
  assert.equal(f.title, "jobs.evaluateTitle");
  assert.equal(f.subtitle, "zhipin.com");
});

test("脏入参不炸（字段缺失的旧台账行）", () => {
  assert.deepEqual(ledgerCardFields({}), { title: "", page: undefined });
  assert.deepEqual(ledgerCardFields({ kind: "evaluate", title: undefined, input: undefined }), { title: "", page: undefined });
});
