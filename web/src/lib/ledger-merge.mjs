// /jobs 历史页的台账合并纯函数（ADR-0045 推定结论：批量去重键 = serverBatchId）。
//
// 台账行与本地卡按 run 标识归并：单次 run 认 `runId`（ADR-0027 follow-up 的
// 既有行为），批量认 open 事件下发的 `serverBatchId`（= 批量台账记录的 id）。
// 同一批量在两边都出现时本地卡胜出（状态更丰富），台账行不得再生成一条
// ledger-only 重复行。Plain .mjs：node --test 锁定。

/**
 * 过滤出「本浏览器没见过的」台账行。
 * @template {{id?: string, parentId?: string}} T
 * @param {Array<{runId?: string, serverBatchId?: string}> | undefined} jobs - 本地卡（job-store）
 * @param {Array<T> | undefined} ledgerRuns - GET /api/runs/history 的行
 * @returns {T[]} 去重后的 ledger-only 行（保持入参顺序，即最新在前）
 */
export function ledgerOnlyRuns(jobs, ledgerRuns) {
  const knownIds = new Set();
  for (const j of jobs ?? []) {
    if (j?.runId) knownIds.add(j.runId);
    if (j?.serverBatchId) knownIds.add(j.serverBatchId);
  }
  // ADR-0046：带 parentId 的批量子任务行不进列表（只经父卡片展开进入 /jobs/[id]）。
  return (ledgerRuns ?? []).filter((r) => r && r.id && !r.parentId && !knownIds.has(r.id));
}
