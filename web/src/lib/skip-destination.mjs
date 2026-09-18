/**
 * 报告页「跳过」按钮的落点纯决策。跳过 = 把该行标为 SKIP 后前进（ADR-0040，
 * 与批量跳过同落点）；这里只管前进到哪。与「返回」按钮（nav-back.mjs，ADR-0019）
 * 同类：纯逻辑落 plain .mjs 才能被 node --test 锁住（房规）。
 *
 * 三档落点：
 * 1. 有下一份 → replace 到下一份。replace 让被跳过的这份不进返回栈——连跳多份后
 *    「返回」直接回列表，而不是一路撞见自己刚丢掉的东西。与右上角 prev/next 的
 *    push 浏览语义有意不同构：跳过是放弃，浏览是正常前进。
 * 2. 无下一份且在列表上下文 → replace 回列表页（保留 tab/排序/搜索上下文）。
 * 3. 深链页（/report/{n}，无列表上下文）→ 维持旧行为 push 回首页：它没有队列，
 *    「下一份」无从谈起。
 *
 * @param {object} p
 * @param {string|null} p.nextHref 下一份报告的链接（含列表上下文），无下一份为 null
 * @param {string} [p.fallbackHref] 无下一份时的列表页兜底链接（含上下文）
 * @param {boolean} p.hasListContext 是否处于列表上下文（/pipeline/{n} 渲染为 true，
 *   深链 /report/{n} 为 false）
 * @returns {{href: string, replace: boolean}} href 为目标路由；replace 为 true 时
 *   用 router.replace（不进历史），否则 router.push
 */
export function skipDestination({ nextHref, fallbackHref, hasListContext }) {
  if (!hasListContext) return { href: "/", replace: false };
  if (nextHref) return { href: nextHref, replace: true };
  return { href: fallbackHref || "/pipeline", replace: true };
}
