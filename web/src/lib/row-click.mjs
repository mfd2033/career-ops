/**
 * 收件箱行点击选中的判定逻辑 — 纯函数，零 DOM 依赖，客户端可导入
 * （.mjs 供 node --test 锁定，同 inbox-url.mjs / inbox-score.mjs 模式）。
 *
 * ADR-0060：整行可点切换选中，但必须让路给行内已有交互控件
 * （checkbox / 标题链接 / 徽章链接 / Save / Skip），且不得被拖选复制
 * 文字的松手 click 误触发。tracker 表（ADR-0038）用逐格 stopPropagation，
 * 收件箱行结构不同（标题 <a> 包裹整段文字），改为集中式 closest 排除。
 *
 * 入参都是结构化最小对象（带 closest 的元素形状 / 坐标点 / 选区形状），
 * 浏览器侧由 triage-row.tsx 接线时传入真实事件对象。
 */

/** 点击需排除的交互控件（命中其自身或后代都不切换行选中）。 */
export const ROW_CLICK_EXEMPT_SELECTOR = "a,button,input";

/** pointerdown→click 位移超过该像素数判为拖拽手势，不切换选中。 */
export const DRAG_THRESHOLD_PX = 5;

/**
 * 点击目标是否落在交互控件上（含后代冒泡）。
 * @param {Element | null | undefined} target - click 事件的 target。
 * @returns {boolean} true = 排除，行点击不处理。无法判定的目标保守排除。
 */
export function isExemptClickTarget(target) {
  if (!target || typeof target.closest !== "function") return true;
  return target.closest(ROW_CLICK_EXEMPT_SELECTOR) != null;
}

/**
 * 按下点到抬起点是否发生了超阈值的位移（拖拽，典型为行内拖选文字）。
 * @param {{x:number,y:number} | null} down - pointerdown 记录的坐标；null = 无参照，放行。
 * @param {{x:number,y:number}} up - click 事件坐标。
 * @returns {boolean} true = 判为拖拽，抑制本次切换。
 */
export function isDragGesture(down, up) {
  if (!down) return false;
  const dx = up.x - down.x;
  const dy = up.y - down.y;
  return Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
}

/**
 * 页面上是否存在非折叠文本选区（用户刚拖选出文字，松手 click 不该选中行）。
 * @param {{isCollapsed?: boolean} | null | undefined} selection - window.getSelection() 结果。
 * @returns {boolean} true = 选区激活，抑制本次切换。无选区对象时保守放行。
 */
export function isTextSelectionActive(selection) {
  return !!selection && selection.isCollapsed === false;
}
