// 批量逐项登记表（batch item registry）—— ADR-0042 决议 5/6。
//
// WHY THIS EXISTS: 批量评估/体检的逐项结论（item 事件）流过即逝——job-store 只在
// 持有 NDJSON 流的那个页签里累积。详情页在另一个页签打开、或本页签的累积丢失
// （重连/对账后）时，没有任何服务端来源能回答「哪几家已出、哪几家没出」。这里是
// 一个**单用途**的进程内登记：批量路由按 batchId 写入逐项状态，GET /api/batch-items
// 按需拉取恢复。
//
// 生命周期与批量 run 一致：进程重启即清（与 checkup-live / 并发池同语义，ADR-0014
// Q8），不做持久化——重启后正在跑的批量本也会死，语义自洽。历史回看（落盘 ledger）
// 是 ADR-0042 显式排除的后续可选项。
//
// 有界：MAX_BATCH_RUNS 个 run，超出淘汰最老的**已完成** run（在跑的永不淘汰）；
// 单 run 条目数由批量路由自身上限（MAX_URLS/MAX_ITEMS=20）约束。
//
// Plain .mjs（同 checkup-live.mjs）：node --test 锁定，不 import tsx。

/**
 * 一家公司的批量逐项结论。
 * @typedef {{
 *   key: string,            // 去重键：batch-evaluate 用 URL，batch-checkup 用 tracker#
 *   label: string,          // 展示名（URL 或 #n 公司名）
 *   ok: boolean,
 *   skipped: boolean,       // skipped-running 等跳过：不算失败（ADR-0041 决议 5）
 *   score?: number | null,  // batch-evaluate 的评估分
 *   star?: number | null,   // batch-checkup 的体检星级
 *   reportNum?: number,     // ADR-0046：batch-evaluate 成功项预分配的报告号（失败/无报告不带）；
 *                           // 体检侧不需要（报告以 tracker# 为键，已落在 key）
 *   startedAt?: number,     // ADR-0046：子 worker 真实执行起点（ms），供卡片时长；无则不占位
 *   finishedAt?: number,    // ADR-0046：子 worker 结束时刻（ms）
 *   reason?: string,        // 失败/跳过原因（服务端产出，ADR-0041 决议 6）
 *   stderrTail?: string,    // 失败项 stderr 尾部（≤400，路由侧滚动截断）；随快照落
 *                           // 台账供历史回看查死因（秒死不可诊 #132/#1027）。成功项不带。
 *   steps?: Array<{kind: string, label: string, ts?: number}>, // ADR-0049：折叠后的逐工具步骤
 *   ts?: number,            // 可省略——登记表写入时补当前时刻
 * }} BatchItem
 */

/**
 * @typedef {{
 *   batchId: string,
 *   kind: string,           // "batch-evaluate" | "batch-checkup"
 *   total: number,
 *   done: boolean,
 *   items: Map<string, BatchItem>,
 *   createdAt: number,
 * }} BatchRun
 */

/** batchId → run。batchId 是 UUID，全局唯一。 */
const runs = new Map();
const MAX_BATCH_RUNS = 50;

function evictIfOverCap() {
  if (runs.size <= MAX_BATCH_RUNS) return;
  // 只淘汰已完成的；在跑的 run 是登记表存在的意义。
  for (const [id, r] of runs) {
    if (runs.size <= MAX_BATCH_RUNS) break;
    if (r.done) runs.delete(id);
  }
}

/**
 * 登记一个批量 run。重复登记同一 batchId 是幂等的（保留最先那条）。
 * @param {string} batchId
 * @param {{kind: string, total: number}} meta
 * @returns {void}
 */
export function registerBatchRun(batchId, { kind, total }) {
  if (!batchId || runs.has(batchId)) return;
  runs.set(batchId, {
    batchId,
    kind: String(kind ?? ""),
    total: Number(total) || 0,
    done: false,
    items: new Map(),
    createdAt: Date.now(),
  });
  evictIfOverCap();
}

/**
 * 写入/更新一家公司的逐项结论。同 key 重复写入是幂等的（后者覆盖，时间戳刷新）——
 * 事件乱序或重放时归并结果不变。
 * @param {string} batchId
 * @param {BatchItem} item
 * @returns {void}
 */
export function recordBatchItem(batchId, item) {
  const run = runs.get(batchId);
  if (!run || !item || typeof item.key !== "string" || !item.key) return;
  run.items.set(item.key, {
    key: item.key,
    label: String(item.label ?? item.key),
    ok: Boolean(item.ok),
    skipped: Boolean(item.skipped),
    score: typeof item.score === "number" ? item.score : null,
    star: typeof item.star === "number" ? item.star : null,
    // ADR-0046：只有真实报告号才透传（成功判定后路由才带 num），非数值（含字符串）
    // 一律不存，避免读取端拼出打不开的 /report/{num}。缺失不占位（沿 ADR-0043 惯例）。
    reportNum: typeof item.reportNum === "number" ? item.reportNum : undefined,
    startedAt: typeof item.startedAt === "number" ? item.startedAt : undefined,
    finishedAt: typeof item.finishedAt === "number" ? item.finishedAt : undefined,
    reason: typeof item.reason === "string" ? item.reason : undefined,
    // 只有失败项才带 stderrTail；防御性再截一次长度，绝不让整段 stderr 漏进台账行。
    stderrTail:
      typeof item.stderrTail === "string" && item.stderrTail
        ? item.stderrTail.slice(0, 400)
        : undefined,
    // ADR-0049：逐工具步骤透传（有则存，无则不设）。
    steps: Array.isArray(item.steps) && item.steps.length > 0 ? item.steps : undefined,
    ts: typeof item.ts === "number" ? item.ts : Date.now(),
  });
}

/**
 * 批量走到终态（done/error，含诚实门禁判定后）。已完成的 run 保留供查询，
 * 成为淘汰候选；未知 batchId 是 no-op。
 * @param {string} batchId
 * @returns {void}
 */
export function completeBatchRun(batchId) {
  const run = runs.get(batchId);
  if (!run) return;
  run.done = true;
  evictIfOverCap();
}

/**
 * 某个批量的逐项快照（数组拷贝，写入顺序）。未知/已淘汰的 batchId 返回 null——
 * 与空数组区分，调用方据此决定显示「空态」还是「查不到」。
 * @param {string} batchId
 * @returns {BatchItem[] | null}
 */
export function getBatchItems(batchId) {
  const run = runs.get(batchId);
  if (!run) return null;
  return [...run.items.values()];
}

// --- test hooks (unit tests only; not part of the runtime surface) ----------

export function __resetBatchItemsForTest() {
  runs.clear();
}
