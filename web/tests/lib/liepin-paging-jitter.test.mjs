// liepin-paging-jitter.test.mjs — ADR-0070 接线守卫（源码级单测）。
//
// core.js 是浏览器内容脚本，翻页点击的调度式细抖无法在 node:test 里跑真实定时器，
// 这里用源码字符串守卫把关键接线锁住：点击必须经调度 setTimeout + pickPagingGap 触发、
// 不再在 tick 里等距连点、句柄必须受管且收尾清除。任何一侧断线，本测试先红。
// 惯例（同 bsk-progress-wiring.test.mjs）：先剥块注释与行注释，再在语义切片上计数，
// 防注释里的字面量冒充接线证据。
//
// Run: node --test tests/lib/liepin-paging-jitter.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const core = readFileSync(join(ROOT, "extension", "core.js"), "utf8");

/** 剥块注释 + 行注释后再断言（守卫单测惯例）。 */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const src = strip(core);
const count = (re) => (src.match(re) || []).length;

test("翻页点击改由调度 setTimeout + doPageClick 触发，且经 pickPagingGap 取间隔", () => {
  assert.match(src, /function scheduleNextPageClick\(/, "调度函数必须存在");
  assert.match(src, /setTimeout\(doPageClick, delay\)/, "点击经独立 setTimeout 排定，脱离 tick 边界");
  assert.match(src, /scan\.nextPageTimer = trackTimer\(/, "点击句柄纳入受管定时器集合（实例销毁兜底清）");
  assert.ok(count(/SCAN\.pickPagingGap/g) >= 2, "首点 + 每次重排都应经纯函数取间隔，不散落魔数");
});

test("pagingAwareStep 不再等距连点：旧的固定最小间隔门控已移除，click 只在 doPageClick 一处", () => {
  assert.doesNotMatch(src, /Date\.now\(\) - lastClick < SCAN_PAGING_MIN_GAP_MS/, "旧的 tick 边界节流门控必须消失");
  assert.equal(count(/nextBtn\.click\(\)/g), 1, "真实点击只发生在 doPageClick，tick 路径不再自行点击");
});

test("停点纪律：重排前清在途句柄、收尾清 scan.nextPageTimer、scan 初始化含该字段", () => {
  assert.match(src, /if \(scan\.nextPageTimer\) clearTimeout\(scan\.nextPageTimer\)/, "重排前清掉在途定时器，避免叠加点");
  assert.match(src, /if \(s\.nextPageTimer\) \{\s*clearTimeout\(s\.nextPageTimer\)/, "finishScan 收尾清除调度定时器");
  assert.match(src, /nextPageTimer: null,/, "scan 实例初始化带该句柄字段");
});

test("首点错峰 + tick 保留：startScan 分页模式排首个随机间隔，扫描 tick 周期不变", () => {
  assert.match(src, /if \(site\.isPageMode === true\) \{\s*scheduleNextPageClick\(/, "分页扫描进入即排首个随机间隔点击（并发多标签自然错峰）");
  assert.match(src, /setInterval\(scanTick, SCAN_SCROLL_INTERVAL_MS\)/, "扫描 tick 仍保留，继续负责终止判定与翻页重扫");
});
