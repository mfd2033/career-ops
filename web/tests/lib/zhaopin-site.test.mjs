// site-zhaopin 适配对象契约测试（ADR-0006）。
//
// 覆盖 ADR 测试清单里可脱离 DOM 的部分：
//   • isDetailPath —— /jobdetail/{id}.htm 识别、列表/其他路径排除；
//   • site 对象契约形状 —— hostMatch、选择器非空、extraTrackingParams 全量
//     (refcode/srccode/preactionid)、evaluateInlineJd 声明、右栏能力声明
//     (智联是有右栏面板的两栏站,与猎聘相反,ids/ensureRightPaneButton/
//     extractListPaneJd/currentActiveUrl 都提供);
// DOM 依赖的提取/取 URL 函数（extractDetailJd / extractPosterName /
// extractListPaneJd / cardUrl / currentActiveUrl）在真实浏览器手工验证
// (已随智联功能验证通过),node 无 jsdom 不重复测 —— 与 site-liepin 测试同口径。
//
// Run:  node --test tests/lib/zhaopin-site.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "site-zhaopin.js")).href);
// CJS 互操作: module.exports 对象即 default; 具名导出走 cjs-module-lexer 也能拿到。
const { ZHAOPIN_SITE, isDetailPath } = mod.default ?? mod;

test("isDetailPath: /jobdetail/{id}.htm is a detail page", () => {
  assert.equal(isDetailPath("/jobdetail/CC445905420J40842265001.htm"), true);
  assert.equal(isDetailPath("/jobdetail/123.htm"), true);
});

test("isDetailPath: list/search/other paths are NOT detail pages", () => {
  for (const p of [
    "/jobs",
    "/jobs?jl=489&kw=javascript",
    "/",
    "/jobdetail/",
    "/jobdetail/abc",
    "/companydetail/CZ445905420.htm",
    "",
  ]) {
    assert.equal(isDetailPath(p), false, `pathname=${JSON.stringify(p)}`);
  }
});

test("ZHAOPIN_SITE: contract shape required keys are present and non-empty", () => {
  assert.ok(ZHAOPIN_SITE, "site object must be exported");
  assert.ok(ZHAOPIN_SITE.hostMatch instanceof RegExp, "hostMatch must be a RegExp");
  assert.equal(ZHAOPIN_SITE.hostMatch.test("www.zhaopin.com"), true);
  assert.equal(ZHAOPIN_SITE.hostMatch.test("sou.zhaopin.com"), true);
  assert.equal(ZHAOPIN_SITE.hostMatch.test("x.zhaopin.com"), true);
  assert.equal(ZHAOPIN_SITE.hostMatch.test("zhipin.com"), false);
  assert.equal(ZHAOPIN_SITE.hostMatch.test("liepin.com"), false);
  assert.ok(typeof ZHAOPIN_SITE.cardSelector === "string" && ZHAOPIN_SITE.cardSelector.length > 0);
  assert.ok(typeof ZHAOPIN_SITE.linkSelector === "string" && ZHAOPIN_SITE.linkSelector.length > 0);
  assert.equal(typeof ZHAOPIN_SITE.isDetailPath, "function");
  assert.equal(typeof ZHAOPIN_SITE.cardIsList, "function");
  assert.equal(typeof ZHAOPIN_SITE.cardUrl, "function");
  assert.equal(typeof ZHAOPIN_SITE.extractDetailJd, "function");
  assert.equal(typeof ZHAOPIN_SITE.extractPosterName, "function");
});

test("ZHAOPIN_SITE: right-pane capabilities ARE declared (two-pane board, like BOSS / unlike LIEpIN)", () => {
  // 智联搜索页是"左列表+右描述面板"两栏布局 → 提供 BOSS 式右栏能力。core 以
  // typeof 守卫,声明即用;这与猎聘(无右栏,全部缺失)形成对比,契约测试锁死。
  assert.equal(typeof ZHAOPIN_SITE.ids, "object");
  assert.equal(typeof ZHAOPIN_SITE.ensureRightPaneButton, "function");
  assert.equal(typeof ZHAOPIN_SITE.extractListPaneJd, "function");
  assert.equal(typeof ZHAOPIN_SITE.currentActiveUrl, "function");
});

test("ZHAOPIN_SITE: evaluateInlineJd is declared (detail-page eval inlines DOM JD)", () => {
  assert.equal(ZHAOPIN_SITE.evaluateInlineJd, true);
});

test("ZHAOPIN_SITE: extraTrackingParams covers the full ADR-0006 denylist", () => {
  const PARAMS = ["refcode", "srccode", "preactionid"];
  assert.ok(Array.isArray(ZHAOPIN_SITE.extraTrackingParams));
  assert.equal(ZHAOPIN_SITE.extraTrackingParams.length, PARAMS.length,
    `expected ${PARAMS.length} entries, got ${ZHAOPIN_SITE.extraTrackingParams.length}`);
  for (const name of PARAMS) {
    assert.ok(
      ZHAOPIN_SITE.extraTrackingParams.some((re) => re.test(name)),
      `tracking param ${name} must be stripped`,
    );
  }
});