// Tests for extractBrowserQuery() — the CLI scan_queries → browser-mode
// keyword seed. Imports directly from browser-search.mjs (single source of
// truth) so test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/browser-search.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBrowserQuery } from "../../src/lib/browser-search.mjs";

test("first OR group, site: tokens dropped — typical search_queries entry", () => {
  assert.equal(
    extractBrowserQuery("site:zhipin.com 项目经理 郑州 OR 技术经理 郑州 OR IT项目经理 郑州"),
    "项目经理 郑州",
  );
});

test("enabled first entry style with liepin domain", () => {
  assert.equal(
    extractBrowserQuery("site:liepin.com 项目经理 郑州 OR 技术经理 郑州 OR 软件项目经理 郑州"),
    "项目经理 郑州",
  );
});

test("no OR → keeps every non-site token", () => {
  assert.equal(extractBrowserQuery("site:zhaopin.com 技术经理 郑州"), "技术经理 郑州");
});

test("no site:, no OR → plain phrase passes through", () => {
  assert.equal(extractBrowserQuery("项目经理 郑州"), "项目经理 郑州");
});

test("site: token not at the front", () => {
  assert.equal(extractBrowserQuery("技术经理 郑州 site:liepin.com OR 测试"), "技术经理 郑州");
});

test("case-insensitive OR", () => {
  assert.equal(extractBrowserQuery("软件工程师 site:a.com or 高级 or 资深"), "软件工程师");
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

test("first group is site:-only → falls through to the next group", () => {
  assert.equal(extractBrowserQuery("site:liepin.com OR 项目经理 郑州 OR 技术经理"), "项目经理 郑州");
});

test("leading OR does not crash — yields the following phrase", () => {
  assert.equal(extractBrowserQuery("OR 项目经理 郑州"), "项目经理 郑州");
});