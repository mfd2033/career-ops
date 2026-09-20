// 批量 run 的台账落盘（ADR-0045 决议 2/5/6 + 推定结论）。
//
// WHY: 批量路由此前不写 run ledger —— UI 之外（API/脚本/别的浏览器）发起的批量
// 终结后在 /jobs 历史里完全不可见；服务端逐项登记表（batch-items.mjs）是纯内存，
// 重启即清。本模块把「批量终态 → 一条带逐项快照的台账记录」的组装做成纯函数：
// run id = serverBatchId（历史页凭它与本地卡去重），done/error/cancel 都落盘，
// items 快照 cap 100（当前批量上限 20，防御性），溢出只记 total 不丢计数。
// 写盘仍走 run-ledger 的 appendRunRecord，fire-and-forget：台账失败绝不反噬 run。
//
// Plain .mjs（同 batch-items.mjs）：node --test 锁定，不 import tsx。

/** 单条台账记录内嵌逐项快照的上限。 */
export const BATCH_LEDGER_ITEMS_CAP = 100;

/**
 * 组装一条批量 run 的台账记录（纯，不落盘）。
 * @param {{
 *   batchId: string,            // 服务端逐项登记键（= ledger run id）
 *   kind: string,               // "batch-evaluate" | "batch-checkup"
 *   title: string,              // 历史行标题（服务端产出，与单次 run recordEnd 同风格）
 *   input: string,              // 摘要式输入（首项 + 溢出计数），不整列长 URL
 *   startedAt: number,
 *   total: number,              // 选中的项数（快照被 cap 截断时仍以此为准）
 *   status: "done" | "error",
 *   msg?: string,               // 终态文案（取消/全失败原因），截断到 800
 *   cliId?: string,
 *   model?: string,
 *   items?: object[],           // getBatchItems 的逐项快照（写入序）
 * }} meta
 * @returns {object} 可直接交给 appendRunRecord 的记录
 */
export function buildBatchLedgerRecord({ batchId, kind, title, input, startedAt, total, status, msg, cliId, model, items }) {
  const snapshot = Array.isArray(items) ? items.slice(0, BATCH_LEDGER_ITEMS_CAP) : [];
  return {
    id: batchId,
    kind,
    input: String(input ?? ""),
    title,
    status,
    startedAt,
    finishedAt: Date.now(),
    // ADR-0043 运行引擎同口径：派发时请求的运行时/模型，空值不占位（读取端按
    // 「未记录」处理，不回填）。
    cliId: cliId || undefined,
    model: model || undefined,
    msg: msg ? String(msg).slice(0, 800) : undefined,
    total: Number(total) || 0,
    items: snapshot,
  };
}
