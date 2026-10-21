"use strict";

// 托盘图标栅格化 —— 纯函数，不 require electron（可在 node --test 里跑）。
//
// 图形沿用品牌语法（dashboard-ui/gen-icon.py）：圆角方块 + 三根上升白柱，底对齐。
// 方块颜色编码健康度（ADR-0086 决策 5）；size >= 24 才画柱顶趋势线与终点圆点
// —— 16px 上那条线会糊成一团，去掉反而更清楚。
//
// 输出是 BGRA 顺序的 Buffer：nativeImage.createFromBitmap 在 Windows 上按
// 这个顺序读，写成 RGBA 图标会整体变蓝（Kaneo 的 trayicon.cjs 同款约定）。

const SUPERSAMPLE = 4;

const STATE_COLORS = {
  run: [0xd5, 0x74, 0x2e], // 品牌橙 #D5742E
  starting: [0xf0, 0xa9, 0x3f], // 琥珀 #F0A93F
  down: [0x8a, 0x85, 0x7e], // 中性灰 #8A857E
  failed: [0xf2, 0x58, 0x5d], // 语义红 #F2585D
};

const WHITE = [0xff, 0xff, 0xff];
const TREND_MIN_SIZE = 24;

// 版面比例（0..1）。柱宽/间距取原型 32px 的实测比例（4.4/3.2 on 32），
// 比 gen-icon.py 的 256px 版面略宽一点 —— 16px 下仍能分出三根柱。
const G = {
  corner: 50 / 256,
  barWidth: 4.4 / 32,
  gap: 3.2 / 32,
  heights: [56 / 256, 86 / 256, 120 / 256],
  base: 24.5 / 32,
  barRadius: 1.2 / 32,
  trendWidth: 1.6 / 32,
  dotRadius: 2 / 32,
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** 点是否落在圆角矩形内（主轴投影 + 最近角心距离）。 */
function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const radius = Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2);
  const cx = clamp(px, x0 + radius, x1 - radius);
  const cy = clamp(py, y0 + radius, y1 - radius);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 点到线段的距离（趋势线的笔画宽度判定）。 */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : clamp(((px - ax) * vx + (py - ay) * vy) / len2, 0, 1);
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

/** 三根柱的版面（单位坐标）：底对齐、水平居中。 */
function bars() {
  const total = G.barWidth * 3 + G.gap * 2;
  const x0 = (1 - total) / 2;
  return G.heights.map((h, i) => ({
    x0: x0 + i * (G.barWidth + G.gap),
    x1: x0 + i * (G.barWidth + G.gap) + G.barWidth,
    top: G.base - h,
    bottom: G.base,
  }));
}

/**
 * 单位坐标上的一次采样：方块内？柱内？趋势线内？
 * 导出供单测直接断言「16px 与 32px 的差别只在趋势线」。
 */
function whiteAt(ux, uy, withTrend) {
  for (const bar of bars()) {
    if (inRoundRect(ux, uy, bar.x0, bar.top, bar.x1, bar.bottom, G.barRadius)) return true;
  }
  if (!withTrend) return false;

  const tops = bars().map((bar) => ({ x: (bar.x0 + bar.x1) / 2, y: bar.top }));
  for (let i = 0; i + 1 < tops.length; i += 1) {
    if (distToSegment(ux, uy, tops[i].x, tops[i].y, tops[i + 1].x, tops[i + 1].y) <= G.trendWidth / 2) {
      return true;
    }
  }
  const last = tops[tops.length - 1];
  const dx = ux - last.x;
  const dy = uy - last.y;
  return Math.sqrt(dx * dx + dy * dy) <= G.dotRadius;
}

function insideSquare(ux, uy) {
  return inRoundRect(ux, uy, 0, 0, 1, 1, G.corner);
}

/**
 * 画一枚托盘图标，返回 BGRA Buffer（长度 size*size*4）。
 *
 * @param {"run"|"starting"|"down"|"failed"} state 健康度
 * @param {number} size 边长（像素）
 */
function drawTrayIcon(state, size) {
  const side = Math.max(1, Math.round(Number(size) || 0));
  const color = STATE_COLORS[state] || STATE_COLORS.down;
  const withTrend = side >= TREND_MIN_SIZE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const out = Buffer.alloc(side * side * 4, 0);

  for (let py = 0; py < side; py += 1) {
    for (let px = 0; px < side; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const ux = (px + (sx + 0.5) / SUPERSAMPLE) / side;
          const uy = (py + (sy + 0.5) / SUPERSAMPLE) / side;
          if (!insideSquare(ux, uy)) continue;
          covered += 1;
          const c = whiteAt(ux, uy, withTrend) ? WHITE : color;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      if (covered === 0) continue;
      const i = (py * side + px) * 4;
      // 颜色取「被覆盖子样本」的均值、alpha 取覆盖率：边缘不会发黑（预乘的朴素做法会把
      // 透明像素的 0,0,0 一起平均进去）。
      out[i] = Math.round(b / covered);
      out[i + 1] = Math.round(g / covered);
      out[i + 2] = Math.round(r / covered);
      out[i + 3] = Math.round((covered / samples) * 255);
    }
  }
  return out;
}

module.exports = { STATE_COLORS, TREND_MIN_SIZE, G, drawTrayIcon, whiteAt, insideSquare };
