// site-liepin 适配对象契约测试（ADR-0005）。
//
// 覆盖 ADR 测试清单里可脱离 DOM 的部分：
//   • isDetailPath —— /job/ 与 /a/ 变体识别、列表路径排除；
//   • site 对象契约形状 —— hostMatch、选择器非空、extraTrackingParams 全量、
//     evaluateInlineJd 声明、猎聘缺失的可选能力键不声明（core 以 typeof 守卫）。
// DOM 依赖的提取函数（extractDetailJd / extractPosterName / cardIsList）在真实
// 浏览器手工验证（已随 猎聘功能验证 通过），node 无 jsdom 不重复测。
//
// Run:  node --test tests/lib/liepin-site.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "site-liepin.js")).href);
// CJS 互操作: module.exports 对象即 default; 具名导出走 cjs-module-lexer 也能拿到。
const { LIEPIN_SITE, isDetailPath } = mod.default ?? mod;

test("isDetailPath: /job/{id}.shtml and /a/{id}.shtml are detail pages", () => {
  assert.equal(isDetailPath("/job/1985305711.shtml"), true);
  assert.equal(isDetailPath("/a/1985305711.shtml"), true);
  assert.equal(isDetailPath("/job/1.shtml"), true);
});

test("isDetailPath: list/search/other paths are NOT detail pages", () => {
  for (const p of [
    "/zhaopin/",
    "/zhaopin/?key=java",
    "/",
    "/job/",
    "/a/",
    "/job/abc.shtml",
    "/job/1985305711.html",
    "",
  ]) {
    assert.equal(isDetailPath(p), false, `pathname=${JSON.stringify(p)}`);
  }
});

test("LIEPIN_SITE: contract shape required keys are present and non-empty", () => {
  assert.ok(LIEPIN_SITE, "site object must be exported");
  assert.ok(LIEPIN_SITE.hostMatch instanceof RegExp, "hostMatch must be a RegExp");
  assert.equal(LIEPIN_SITE.hostMatch.test("www.liepin.com"), true);
  assert.equal(LIEPIN_SITE.hostMatch.test("x.liepin.com"), true);
  assert.equal(LIEPIN_SITE.hostMatch.test("zhipin.com"), false);
  assert.ok(typeof LIEPIN_SITE.cardSelector === "string" && LIEPIN_SITE.cardSelector.length > 0);
  assert.ok(typeof LIEPIN_SITE.linkSelector === "string" && LIEPIN_SITE.linkSelector.length > 0);
  assert.equal(typeof LIEPIN_SITE.isDetailPath, "function");
  assert.equal(typeof LIEPIN_SITE.cardIsList, "function");
  assert.equal(typeof LIEPIN_SITE.cardUrl, "function");
  assert.equal(typeof LIEPIN_SITE.extractDetailJd, "function");
  assert.equal(typeof LIEPIN_SITE.extractPosterName, "function");
  // 分页型平台扫描契约(猎聘改版为分页显示):core scan mode 以此为据走 DOM 翻页
  // 而非滚动。isPageMode 必须为 true,findNextPageBtn 必须可调(有下一页即返回)。
  assert.equal(LIEPIN_SITE.isPageMode, true, "猎聘搜索页是分页型,不是懒加载滚动");
  assert.equal(typeof LIEPIN_SITE.findNextPageBtn, "function", "分页扫描需提供「下一页」定位函数");
});

test("LIEPIN_SITE: evaluateInlineJd is declared (detail-page eval inlines DOM JD)", () => {
  assert.equal(LIEPIN_SITE.evaluateInlineJd, true);
});

test("LIEPIN_SITE: extraTrackingParams covers the full ADR-0005 denylist", () => {
  const PARAMS = [
    "pgRef", "d_sfrom", "d_ckId", "d_curPage", "d_pageSize", "d_headId", "d_posi",
    "skId", "fkId", "ckId", "sfrom", "curPage", "pageSize", "index",
  ];
  assert.ok(Array.isArray(LIEPIN_SITE.extraTrackingParams));
  assert.equal(LIEPIN_SITE.extraTrackingParams.length, PARAMS.length,
    `expected ${PARAMS.length} entries, got ${LIEPIN_SITE.extraTrackingParams.length}`);
  for (const name of PARAMS) {
    assert.ok(
      LIEPIN_SITE.extraTrackingParams.some((re) => re.test(name)),
      `tracking param ${name} must be stripped`,
    );
  }
});

test("LIEPIN_SITE: BOSS-only optional capabilities are NOT declared (typeof-guard contract)", () => {
  // 猎聘无列表右栏面板;core 以 typeof 守卫这些键,缺失即跳过。
  assert.equal("ids" in LIEPIN_SITE, false);
  assert.equal("ensureRightPaneButton" in LIEPIN_SITE, false);
  assert.equal("extractListPaneJd" in LIEPIN_SITE, false);
  assert.equal("currentActiveUrl" in LIEPIN_SITE, false);
});
