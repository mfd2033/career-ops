// 批量折叠摘要（ADR-0045 决议 9）：从逐项 items 现算「n 项 · x 成功 · y 失败」
// 所需计数，纯函数、无存储。口径与详情页/登记表一致：skipped（skipped-running
// 等跳过）单列、不算失败（ADR-0041 决议 5）；n 取 total 与 items 数的较大者
// ——快照被台账 cap 截断或运行中只完成一部分时，总数都不失真。
//
// Plain .mjs（同 ledger-merge.mjs）：node --test 锁定。

/**
 * @typedef {{ n: number, ok: number, failed: number, skipped: number, hasItems: boolean }} BatchSummary
 */

/**
 * @param {Array<{ok?: boolean, skipped?: boolean}> | null | undefined} items - 逐项快照（本地卡或台账）
 * @param {number | null | undefined} total - 批量选中总数（Job.batchTotal / 台账 total），可缺
 * @returns {BatchSummary}
 */
export function batchSummary(items, total) {
  const list = Array.isArray(items) ? items.filter((i) => i && typeof i === "object") : [];
  const ok = list.filter((i) => i.ok).length;
  const skipped = list.filter((i) => !i.ok && i.skipped).length;
  const failed = list.filter((i) => !i.ok && !i.skipped).length;
  const n = Math.max(Number(total) || 0, list.length);
  return { n, ok, failed, skipped, hasItems: list.length > 0 };
}
