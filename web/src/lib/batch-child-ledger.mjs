// 批量子任务的独立台账行（ADR-0046）。
//
// WHY: 一个批量在台账里原本只有「一行 = 一个工作单元」（ADR-0045）。本次要让
// 每个成功子项能被 /jobs/[id] 当作一个独立工作器打开（诚实子集视图），故在
// 子项成功的瞬间各写一条子台账行，用 parentId 关联父批量。失败/跳过/取消项不写
// （它们没有可跳的报告，详情页会是空壳）。
//
// 确定性 id = fnv1a(batchId::key)：路由（服务端落盘）与卡片（客户端算出点击目标）
// 两侧必须得到同一个 id，故这里不 import node:crypto —— 纯 JS FNV-1a，服务端/
// 浏览器都能跑（同 started-at.mjs / cli-labels.mjs 的纪律）。batchId 是 UUID，已
// 把不同批量彼此隔开；单批量 <=20 项，32 位散列在 200 行窗口内碰撞概率可忽略。
//
// Plain .mjs：node --test 锁定，不 import tsx。

/**
 * 子项的确定性台账 id（服务端与客户端共用，URL 路径段安全）。
 * @param {string} batchId - 父批量的 serverBatchId
 * @param {string} key - 子项去重键（evaluate=URL，checkup=tracker#）
 * @returns {string}
 */
export function batchChildId(batchId, key) {
  const s = `${batchId}::${key}`;
  // FNV-1a (32-bit)
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `bci-${h.toString(16)}`;
}

/**
 * 组装一条子任务台账记录（纯，不落盘）。只对成功项调用。
 * @param {{
 *   batchId: string,          // 父 serverBatchId（= 子行 parentId）
 *   childKind: string,        // "batch-evaluate-item" | "batch-checkup-item"
 *   key: string,              // 子项去重键（evaluate=URL，checkup=tracker#）
 *   label: string,            // 展示标题
 *   startedAt: number,        // 子 worker 真实执行起点
 *   finishedAt: number,
 *   cliId?: string,           // 继承批量派发时的运行时
 *   model?: string,
 *   reportNum?: number,       // evaluate 报告号（跳 /report/{num}）
 *   trackerN?: string | number, // checkup 报告键（跳 /api/checkup-report?n=）
 *   steps?: Array<{kind: string, label: string, ts?: number}>, // ADR-0049：折叠后的逐工具步骤
 * }} p
 * @returns {object} 可直接交给 appendRunRecord 的子记录
 */
export function buildBatchChildRecord({ batchId, childKind, key, label, startedAt, finishedAt, cliId, model, reportNum, trackerN, steps }) {
  const rec = {
    id: batchChildId(batchId, key),
    parentId: batchId,
    kind: String(childKind),
    input: String(key ?? ""),
    title: String(label ?? key ?? ""),
    status: "done",
    startedAt,
    finishedAt,
  };
  // 可选字段缺失即整个不占位（沿 ADR-0043 惯例），读取端按「未记录」处理。
  if (cliId) rec.cliId = cliId;
  if (model) rec.model = model;
  // 报告目标二选一。
  if (typeof reportNum === "number") rec.reportNum = reportNum;
  if (trackerN != null && trackerN !== "") rec.trackerN = String(trackerN);
  // ADR-0049：逐工具步骤折叠后写入（同 ADR-0047 单任务 steps 格式）。
  if (Array.isArray(steps) && steps.length > 0) rec.steps = steps;
  return rec;
}

/**
 * 子项卡片是否可点、以及目标（ADR-0046，服务端/客户端共用）。
 * 仅当知道父批量 id 且该子项成功（有子台账行）时，才可点 → /jobs/{childId}；
 * 否则返回 null（失败/跳过/无报告项不可点）。
 * @param {string | undefined} batchId - 父 serverBatchId
 * @param {{ key: string, ok?: boolean } | null | undefined} item
 * @returns {string | null}
 */
export function batchItemDetailHref(batchId, item) {
  if (!batchId || !item || !item.ok || !item.key) return null;
  return `/jobs/${batchChildId(batchId, item.key)}`;
}
