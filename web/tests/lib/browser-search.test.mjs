// Tests for extractBrowserQuery() — the CLI scan_queries → browser-mode
// keyword seed. Imports directly from browser-search.mjs (single source of
// truth) so test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/browser-search.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBrowserQuery, buildSearchUrls, expandSearchTargets } from "../../src/lib/browser-search.mjs";

test("drops site:/OR/city tokens and keeps every position keyword across OR groups", () => {
  assert.equal(
    extractBrowserQuery("site:zhipin.com 项目经理 郑州 OR 技术经理 郑州 OR IT项目经理 郑州"),
    "项目经理 技术经理 IT项目经理",
  );
});

test("typical first entry with liepin domain — city stripped, all groups kept", () => {
  assert.equal(
    extractBrowserQuery("site:liepin.com 项目经理 郑州 OR 技术经理 郑州 OR 软件项目经理 郑州"),
    "项目经理 技术经理 软件项目经理",
  );
});

test("no OR → keeps every non-site, non-city token", () => {
  assert.equal(extractBrowserQuery("site:zhaopin.com 技术经理 郑州"), "技术经理");
});

test("no site:, no OR → plain phrase passes with city dropped", () => {
  assert.equal(extractBrowserQuery("项目经理 郑州"), "项目经理");
});

test("site: token not at the front", () => {
  assert.equal(extractBrowserQuery("技术经理 郑州 site:liepin.com OR 测试"), "技术经理 测试");
});

test("case-insensitive OR — tokens across OR kept, city/descriptors remain", () => {
  assert.equal(extractBrowserQuery("软件工程师 site:a.com or 高级 or 资深"), "软件工程师 高级 资深");
});

test("empty / whitespace-only input → empty string", () => {
  assert.equal(extractBrowserQuery(""), "");
  assert.equal(extractBrowserQuery("   "), "");
  assert.equal(extractBrowserQuery(undefined), "");
  assert.equal(extractBrowserQuery(null), "");
});

test("only site: tokens → empty string", () => {
  assert.equal(extractBrowserQuery("site:zhipin.com site:liepin.com"), "");
});

test("site:-only first group → falls through and keeps later position keywords", () => {
  assert.equal(extractBrowserQuery("site:liepin.com OR 项目经理 郑州 OR 技术经理"), "项目经理 技术经理");
});

test("leading OR does not crash — yields the following phrase without city", () => {
  assert.equal(extractBrowserQuery("OR 项目经理 郑州"), "项目经理");
});

// ── buildSearchUrls / expandSearchTargets —— 多关键词展开与猎聘单关键词限制 ──

test("buildSearchUrls keeps one URL per source with OR-joined query", () => {
  const urls = buildSearchUrls(["zhipin", "liepin", "zhaopin"], "经理 OR 工程师", "郑州");
  assert.equal(urls.length, 3);
  for (const u of urls) assert.ok(u.includes("OR"), `期望 OR 保留在整串查询里: ${u}`);
});

test("expandSearchTargets splits liepin multi-keyword into one URL per word", () => {
  // 猎聘搜索框不支持 OR/空格分隔的多关键词 —— 逐词拆成多条搜索 URL。
  const targets = expandSearchTargets(["liepin"], "经理 OR 工程师 OR 架构师", "郑州");
  assert.equal(targets.length, 3);
  assert.ok(targets.every((t) => t.source === "liepin"));
  assert.ok(targets.some((t) => t.url.includes(encodeURIComponent("经理"))), "含第一词 URL");
  assert.ok(targets.some((t) => t.url.includes(encodeURIComponent("工程师"))), "含第二词 URL");
  assert.ok(targets.some((t) => t.url.includes(encodeURIComponent("架构师"))), "含第三词 URL");
});

test("expandSearchTargets keeps BOSS/zhaopin as a single OR-joined URL (they accept multi keywords)", () => {
  const targets = expandSearchTargets(["zhipin", "zhaopin"], "经理 OR 工程师", "郑州");
  assert.equal(targets.length, 2); // 每源仍一条
  for (const t of targets) assert.ok(t.url.includes("OR"));
});

test("expandSearchTargets mixes sources correctly without heal-order drift", () => {
  const targets = expandSearchTargets(["zhipin", "liepin"], "经理 OR 工程师", "");
  // order: zhipin×1, liepin×2
  assert.equal(targets.length, 3);
  assert.equal(targets[0].source, "zhipin");
  assert.equal(targets[1].source, "liepin");
  assert.equal(targets[2].source, "liepin");
});

test("expandSearchTargets empty liepin query degrades to a single national search", () => {
  const targets = expandSearchTargets(["liepin"], "  ", "郑州");
  assert.equal(targets.length, 1);
  assert.ok(targets[0].url.startsWith("https://www.liepin.com/zhaopin/?key="));
});