// Tests for extractBrowserQuery() — the CLI scan_queries → browser-mode
// keyword seed. Imports directly from browser-search.mjs (single source of
// truth) so test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/browser-search.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBrowserQuery } from "../../src/lib/browser-search.mjs";

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