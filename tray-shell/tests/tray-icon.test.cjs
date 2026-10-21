"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STATE_COLORS, TREND_MIN_SIZE, drawTrayIcon, whiteAt } = require("../src/tray-icon.cjs");

function pixel(buffer, size, x, y) {
  const i = (y * size + x) * 4;
  return { b: buffer[i], g: buffer[i + 1], r: buffer[i + 2], a: buffer[i + 3] };
}

// 版面常量（与 tray-icon.cjs 的 G 对应）：柱子从 x≈0.194 起，中心竖条区避开它们。
const COLOR_POINT = { x: 2, y: 16 };
const BAR_POINT = { x: 23, y: 22 };
const TREND_POINT = { x: 0.38125, y: 0.4883 }; // 前两根柱之间的趋势线中段

test("四角透明：圆角方块之外没有像素", () => {
  for (const size of [16, 32]) {
    const icon = drawTrayIcon("run", size);
    assert.equal(pixel(icon, size, 0, 0).a, 0, `size=${size} 左上角应透明`);
    assert.equal(pixel(icon, size, size - 1, size - 1).a, 0, `size=${size} 右下角应透明`);
  }
});

test("方块内、柱外 = 状态色（BGRA 顺序）", () => {
  for (const [state, rgb] of Object.entries(STATE_COLORS)) {
    const icon = drawTrayIcon(state, 32);
    const px = pixel(icon, 32, COLOR_POINT.x, COLOR_POINT.y);
    assert.equal(px.a, 255, `${state} 应完全不透明`);
    assert.deepEqual([px.r, px.g, px.b], rgb, `${state} 的填充色不对`);
  }
});

test("柱子是白的", () => {
  const px = pixel(drawTrayIcon("run", 32), 32, BAR_POINT.x, BAR_POINT.y);
  assert.equal(px.a, 255);
  assert.ok(px.r > 250 && px.g > 250 && px.b > 250, "柱内像素应为白");
});

test("趋势线只在 size >= 24 时画（16px 会糊成一团）", () => {
  assert.equal(TREND_MIN_SIZE, 24);
  assert.equal(whiteAt(TREND_POINT.x, TREND_POINT.y, true), true, "带趋势线时应命中线段");
  assert.equal(whiteAt(TREND_POINT.x, TREND_POINT.y, false), false, "无趋势线时该点应是底色");
});

test("16px 与 32px 的差别落在趋势线上，而不是形状上", () => {
  const big = pixel(drawTrayIcon("run", 32), 32, 12, 15); // 趋势线中段
  const small = pixel(drawTrayIcon("run", 16), 16, 6, 7); // 同一位置（含柱子边缘）
  assert.ok(big.r > 250 && big.g > 250, "32px 该处应是趋势线的白");
  assert.ok(small.r < 250, "16px 同一处不应是纯白（没有趋势线）");
});

test("缓冲区长度与尺寸对齐", () => {
  for (const size of [16, 32]) {
    assert.equal(drawTrayIcon("down", size).length, size * size * 4);
  }
});
