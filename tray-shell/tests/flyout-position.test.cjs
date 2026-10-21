"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeFlyoutPosition, GAP } = require("../src/flyout-position.cjs");

// 1920×1040 的屏幕，任务栏在底部 → workArea 少 40px
const display = { workArea: { x: 0, y: 0, width: 1920, height: 1000 } };
const size = { width: 404, height: 520 };

test("锚点在右下（底部任务栏）：面板向上翻、水平居中于图标", () => {
  const pos = computeFlyoutPosition(display, { x: 1300, y: 980 }, size);
  assert.equal(pos.side, "top");
  assert.equal(pos.y, 980 - 520 - GAP);
  assert.equal(pos.x, 1300 - 202);
});

test("锚点在左上（顶部任务栏）：面板向下挂", () => {
  const pos = computeFlyoutPosition(display, { x: 300, y: 20 }, size);
  assert.equal(pos.side, "bottom");
  assert.equal(pos.y, 20 + GAP);
  assert.equal(pos.x, 300 - 202);
});

test("右边缘越界：夹回工作区", () => {
  const pos = computeFlyoutPosition(display, { x: 1910, y: 900 }, size);
  assert.equal(pos.x, 1920 - 404 - GAP);
});

test("左边缘越界：夹回工作区", () => {
  const pos = computeFlyoutPosition(display, { x: 10, y: 900 }, size);
  assert.equal(pos.x, GAP);
});

test("顶部越界：向上翻时 y 不小于工作区上沿 + 间距", () => {
  const pos = computeFlyoutPosition(display, { x: 800, y: 820 }, { width: 404, height: 900 });
  assert.equal(pos.y, GAP);
});

test("拿不到锚点：落在工作区右下角", () => {
  const pos = computeFlyoutPosition(display, null, size);
  assert.deepEqual(pos, { x: 1920 - 404 - GAP, y: 1000 - 520 - GAP, side: "bottom" });
});

test("副屏（负坐标）同样按该屏 workArea 夹取", () => {
  const second = { workArea: { x: -1600, y: 0, width: 1600, height: 860 } };
  const pos = computeFlyoutPosition(second, { x: -80, y: 820 }, size);
  assert.equal(pos.x, -1600 + 1600 - 404 - GAP);
  assert.equal(pos.side, "top");
});
