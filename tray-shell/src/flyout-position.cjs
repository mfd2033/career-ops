"use strict";

// 托盘面板定位 —— 纯计算，不依赖 electron（可在 node --test 里跑）。
//
// 以「点开面板时的鼠标位置」为锚点把面板贴到图标旁。Windows 任务栏、各类
// dock/菜单栏外壳都不会改 workArea 或给准托盘图标坐标，只有点击位置可靠；
// 最后再把结果夹回工作区，避免面板移出屏幕。逐字平移自
// D:\workspace\kaneo\.scratch\kaneo-tray\src\flyout-position.cjs（ADR-0086 决策 6）。

const GAP = 12;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * @param {{workArea: {x: number, y: number, width: number, height: number}}} display
 * @param {{x: number, y: number} | null} anchor 点开面板时的鼠标屏幕坐标（DIP）；拿不到时退回工作区右下角
 * @param {{width: number, height: number}} size
 * @param {number} gap
 * @returns {{x: number, y: number, side: "bottom"|"top"}}
 */
function computeFlyoutPosition(display, anchor, size, gap = GAP) {
  const { workArea } = display;
  const { width, height } = size;

  const left = workArea.x + gap;
  const right = Math.max(left, workArea.x + workArea.width - width - gap);
  const top = workArea.y + gap;
  const bottom = Math.max(top, workArea.y + workArea.height - height - gap);

  if (!anchor) return { x: right, y: bottom, side: "bottom" };

  // 锚点在上半屏就往下挂（顶部菜单栏/顶部任务栏），在下半屏就往上翻（底部任务栏）
  const below = anchor.y < workArea.y + workArea.height / 2;
  return {
    x: clamp(Math.round(anchor.x - width / 2), left, right),
    y: clamp(Math.round(below ? anchor.y + gap : anchor.y - height - gap), top, bottom),
    side: below ? "bottom" : "top",
  };
}

module.exports = { GAP, computeFlyoutPosition };
