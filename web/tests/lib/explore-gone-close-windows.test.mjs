// explore-gone-close-windows.test.mjs — ADR-0066 决议 4 接线守卫（源码级单测）。
//
// background.js 是 service worker 脚本，无法在 node:test 里执行（chrome API 缺失）；
// 这里用源码字符串守卫锁住「探索页被关 → 停采集后按同一保护规则关窗 + 清窗口账」
// 这条接线。关窗判定自身的纯逻辑由 wrapup-pure.test.mjs 覆盖。
//
// Run: node --test tests/lib/explore-gone-close-windows.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bg = readFileSync(join(here, "../../../extension/background.js"), "utf8");

/** 剥块注释后再断言，防止注释里的字面量冒充接线证据（守卫单测惯例）。 */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("探索页被关：停采集后按同一保护规则关窗并清窗口账", () => {
  const src = strip(bg);
  assert.match(src, /decideAfterExploreGone/, "探索页关闭要走 decideAfterExploreGone 停掉采集");
  assert.match(
    src,
    /for \(const sid of \[\.\.\.scanWindows\.keys\(\)\]\) closeScanWindows\(sid, null\)/,
    "探索页被关时必须遍历窗口账逐个关窗（并随之清账）",
  );
  assert.match(src, /WRAPUP\.decideCloseWindows\(/, "关窗保护规则统一走 decideCloseWindows，不另立一套");
});