// explore-window-bounds.mjs — ADR-0066 下半屏采集窗口布局的纯计算层。
//
// 探索页发起浏览器扫描时，为每个平台目标算一个铺满屏幕下半部的窗口 bounds，
// 按目标数 N 等宽并排（1 个满宽 / 2 个各半 / 3 个各⅓），高度约为可用屏高一半。
// 尺寸来自发起页的 window.screen（CSS px = Chrome 窗口 bounds 的 DIP，无需按
// devicePixelRatio 换算）；本函数只吃一个 screen 形状，好脱离浏览器单测。
//
// 不做多显示器/负坐标特化：availLeft/availTop 原样平移，够用单显示器常见场景。

/**
 * 计算 N 个下半屏窗口的 bounds。
 * @param {number} n 窗口数（= 采集目标数，ADR-0066 单关键词约束下 ≤ 选中平台数 ≤3）
 * @param {{availLeft?:number, availTop?:number, availWidth?:number, availHeight?:number}} screen
 *   发起页所在显示器的可用区域（window.screen 的 avail* 四值）
 * @returns {Array<{left:number, top:number, width:number, height:number}>} 按 i 顺序左→右平铺
 */
export function computeBottomHalfBounds(n, screen) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return [];
  const { availLeft = 0, availTop = 0, availWidth = 0, availHeight = 0 } = screen || {};
  const halfTop = Math.floor(availHeight / 2);
  const top = availTop + halfTop;
  const height = availHeight - halfTop;
  const per = Math.floor(availWidth / count);
  const out = [];
  for (let i = 0; i < count; i++) {
    // 末窗吸收整除余数，保证 N 个窗口恰好铺满整行宽度、右侧不留缝。
    const width = i === count - 1 ? availWidth - per * (count - 1) : per;
    out.push({ left: availLeft + per * i, top, width, height });
  }
  return out;
}
