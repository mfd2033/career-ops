/**
 * 详情页「返回」按钮的纯决策（ADR-0019）。输入应用内会话栈的前一路由
 * （`prevNavHistory()` 的结果）、浏览器历史深度与无栈时的兜底路由，输出这一次
 * 点击该执行 `back()` 还是 `replace()`。`nav-history.ts` 负责读栈与执行，这里
 * 只做决策——纯逻辑落 plain .mjs 才能被 node --test 锁住（房规，同 report-num.mjs）。
 *
 * 守卫：Chrome 会把 sessionStorage 复制给 target="_blank" 打开的新标签页，此时
 * 应用内栈有「前一页」而浏览器历史没有后退项——back() 静默无效，用户点了没反应。
 * history.length > 1 才信任 back()，否则退化为 replace（前一页仍已知就去前一页）。
 */
export function backNavPlan(prev, historyLength, fallback) {
  if (prev && historyLength > 1) return { kind: "back" };
  return { kind: "replace", url: prev ?? fallback };
}
