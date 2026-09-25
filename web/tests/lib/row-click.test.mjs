// 收件箱行点击选中的判定纯函数测试（ADR-0060 决议 1/3/7）。
// 零 DOM 依赖：入参用结构化最小对象（带 closest 的假元素 / 坐标点 / 选区形状），
// 组件侧只剩事件接线。
//
// Run:  node --test tests/lib/row-click.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROW_CLICK_EXEMPT_SELECTOR,
  DRAG_THRESHOLD_PX,
  isExemptClickTarget,
  isDragGesture,
  isTextSelectionActive,
} from "../../src/lib/row-click.mjs";

// 假元素：closest 命中给定选择器时返回自身，否则 null。
function fakeEl(hit) {
  return { closest: (sel) => (hit ? { sel } : null) };
}

test("排除选择器逐字锁定 — a/button/input 三类控件", () => {
  assert.equal(ROW_CLICK_EXEMPT_SELECTOR, "a,button,input");
});

test("拖拽阈值逐字锁定 — 5px 是 ADR-0060 的工程常数", () => {
  assert.equal(DRAG_THRESHOLD_PX, 5);
});

test("命中交互控件（或其后代）的点击被排除", () => {
  // closest 语义已在浏览器端覆盖后代冒泡，这里只需模拟命中/未命中两分支。
  assert.equal(isExemptClickTarget(fakeEl(true)), true);
  assert.equal(isExemptClickTarget(fakeEl(false)), false);
});

test("无 closest 能力的目标保守排除 — 判不了就不切换", () => {
  assert.equal(isExemptClickTarget(null), true);
  assert.equal(isExemptClickTarget(undefined), true);
  assert.equal(isExemptClickTarget({}), true);
});

test("位移恰等于阈值不算拖拽，超过才算", () => {
  const down = { x: 100, y: 50 };
  assert.equal(isDragGesture(down, { x: 105, y: 50 }), false); // 恰 5px
  assert.equal(isDragGesture(down, { x: 106, y: 50 }), true); // 6px
  assert.equal(isDragGesture(down, { x: 103, y: 54 }), false); // 斜向 5px
  assert.equal(isDragGesture(down, { x: 104, y: 54 }), true); // 斜向 ≈5.66px
});

test("缺少按下记录不视为拖拽 — 无参照时放行切换", () => {
  assert.equal(isDragGesture(null, { x: 100, y: 100 }), false);
});

test("非折叠选区判为拖选复制 — 抑制行点击", () => {
  assert.equal(isTextSelectionActive({ isCollapsed: false }), true);
  assert.equal(isTextSelectionActive({ isCollapsed: true }), false);
});

test("无选区对象（环境不支持）保守放行", () => {
  assert.equal(isTextSelectionActive(null), false);
  assert.equal(isTextSelectionActive(undefined), false);
});
