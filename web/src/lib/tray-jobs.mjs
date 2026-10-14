/**
 * 侧栏托盘（WorkerPills）的卡片选取 — 纯函数，node --test 锁定。
 *
 * 托盘合并三个来源后（本地卡 + 池投影 + ledger-only 终态卡）6 个名额如何
 * 分配是决策点：进行中（running/queued）永远全部保留、不截断——池满时
 * 排队卡可以有很多张，藏掉任何一张都是把进行中的工作掖起来；剩余名额
 * 由终态卡（本地 done/error + ledger-only）按 startedAt 新者优先填。
 *
 * 历史：托盘曾只渲染本地卡 + 池投影，跨页签/扩展发起、只活在服务端台账
 * 里的终态任务在托盘彻底消失（/jobs 主列表有 ledgerOnlyRuns 合并，托盘
 * 没有）。本函数是那次修复的选取规则。
 *
 * @template {{status: string, startedAt?: number}} T
 * @param {T[] | undefined} jobs 本地卡 + 池投影（activeCards 在前、本地卡次之的既有顺序）
 * @param {T[] | undefined} ledgerOnlyCards ledgerRunsToCards 生成的终态卡
 * @param {number} limit 终态名额上限（进行中的不计入）
 * @returns {T[]} 进行中原序在前，终态按时间新→旧填剩余名额
 */
export function pickTrayJobs(jobs, ledgerOnlyCards, limit) {
  const all = [...(jobs ?? []), ...(ledgerOnlyCards ?? [])];
  const active = all.filter((j) => j && (j.status === "running" || j.status === "queued"));
  const settled = all
    .filter((j) => j && j.status !== "running" && j.status !== "queued")
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const room = Math.max(0, (Number.isFinite(limit) ? limit : settled.length) - active.length);
  return [...active, ...settled.slice(0, room)];
}
