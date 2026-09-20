// 运行中批量的展开态实时数据归并（ADR-0045 决议 8）——纯函数，node --test 锁定。
//
// 轮询只是详情页既有恢复通道（GET /api/batch-items，3s）在列表展开行的复用：
// 「拉什么、何时拉」是这里的两个纯判定/归并，「何时启停定时器」留给组件接线。

/**
 * 服务端登记表快照与本地累积的逐项清单按 key 归并；本地卡后写入、同键胜出
 * （与详情页 itemMap 同一顺序语义：本地流带着更实时的单项结论）。
 * @param {Array<{key: string}> | null | undefined} serverItems
 * @param {Array<{key: string}> | null | undefined} localItems
 * @returns {Array<any>} 归并后的清单（服务端序在前，本地追加/覆盖）
 */
export function mergeBatchItems(serverItems, localItems) {
  const map = new Map();
  for (const it of serverItems ?? []) if (it && it.key) map.set(it.key, it);
  for (const it of localItems ?? []) if (it && it.key) map.set(it.key, it);
  return [...map.values()];
}

/**
 * 是否需要为该行的展开态拉登记表：仅当 展开中 且 运行中 且 持有登记键。
 * 折叠不为不可见的数据花请求；无 serverBatchId 的行（ledger-only 终态行、
 * 并发池快照卡）没有可拉的批量。
 * @param {{ open?: boolean, running?: boolean, serverBatchId?: string | null }} state
 * @returns {boolean}
 */
export function shouldPollBatch({ open, running, serverBatchId }) {
  return Boolean(open && running && serverBatchId);
}
