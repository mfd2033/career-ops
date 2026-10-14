/**
 * 影子卡片接管（adopt）的选取逻辑 — 纯函数，零 DOM 依赖，客户端可导入
 * （.mjs 供 node --test 锁定，同 job-retry.mjs 模式）。
 *
 * 问题：/api/events 的帧按 run UUID（run-events 总线）索引，而工作器列表
 * 里别的页签/扩展发起（或本页签刷新后失配）的单任务，只是 /api/active-runs
 * 轮询合成的影子卡（steps 永远是一条「处理中」占位）。两套 ID 之间缺一条
 * 连接——服务端快照现在携带 runId（见 concurrency-pool.ts 的同名注释），
 * 本函数决定哪些条目该被登记进 runId→卡片 映射并接管为真实卡片。
 *
 * 只接管 source "run" 且带字符串 runId 的条目：批量 worker 走自己的
 * NDJSON 响应流、从不发布到总线，接管它们只会得到另一张死卡。
 */

/** 接管卡的 id 前缀（id = 前缀 + runId）——job-store 的建卡/同步/免存盘
 *  守卫共用这一个常量，不各自拼字面量。 */
export const ADOPT_PREFIX = "adopt-";

/**
 * @typedef {Object} AdoptableRun
 * @property {string} runId         事件总线 UUID——接 /api/events 帧的键
 * @property {string} url           任务输入（影子卡与本地卡去重的依据）
 * @property {string} title
 * @property {string|undefined} kind  任务类型（evaluate/pdf/checkup…）——随 meta
 *   入池后快照才能带出；缺失时调用方回退展示型 kind。
 * @property {string|undefined} cliId
 * @property {string|undefined} model
 * @property {"running"|"queued"} status
 * @property {number} startedAt     running = 真实获槽时刻；queued = 入队时刻（不假报起点）
 * @property {number|undefined} enqueuedAt
 * @property {number|undefined} queuedPos
 */

/**
 * 从一次 active-runs 快照里挑出应接管的单任务条目。
 *
 * 幂等约束（轮询每 3s 一次）：已接管的凭 mappedRunIds 跳过；本页签已收到
 * 终态事件的凭 terminalRunIds 跳过（轮询响应可能晚于 done 事件落地，
 * 不拦会把定局卡重建成「处理中」并抹掉结论）；发起页签在 POST /api/run
 * 往返窗口里（本地卡已建、runId 尚未回）凭 localActiveInputs 的 URL 跳过——
 * 那段时间映射表还拦不住，不跳会给同一个 run 建两张卡。
 *
 * @param {{ running?: unknown[], queued?: unknown[] } | null | undefined} snapshot
 * @param {{ mappedRunIds: Set<string>, localActiveInputs: Set<string>, terminalRunIds?: Set<string> }} guards
 * @returns {AdoptableRun[]} running 在前、queued 在后（与工作器列表的既有顺序一致）
 */
export function pickAdoptableRuns(snapshot, guards) {
  const out = [];
  if (!snapshot || typeof snapshot !== "object") return out;
  const { mappedRunIds, localActiveInputs, terminalRunIds } = guards || {};
  const isAdoptable = (e) => {
    if (!e || typeof e !== "object") return false;
    if (e.source !== "run") return false;
    if (typeof e.runId !== "string" || !e.runId) return false;
    if (mappedRunIds?.has(e.runId)) return false;
    if (terminalRunIds?.has(e.runId)) return false;
    if (typeof e.url === "string" && localActiveInputs?.has(e.url)) return false;
    return true;
  };
  for (const r of Array.isArray(snapshot.running) ? snapshot.running : []) {
    if (!isAdoptable(r)) continue;
    out.push({
      runId: r.runId, url: r.url, title: r.title, kind: r.kind,
      cliId: r.cliId, model: r.model, status: "running",
      startedAt: r.startedAt ?? r.enqueuedAt, enqueuedAt: r.enqueuedAt,
      queuedPos: undefined,
    });
  }
  for (const q of Array.isArray(snapshot.queued) ? snapshot.queued : []) {
    if (!isAdoptable(q)) continue;
    out.push({
      runId: q.runId, url: q.url, title: q.title, kind: q.kind,
      cliId: q.cliId, model: q.model, status: "queued",
      startedAt: q.enqueuedAt, enqueuedAt: q.enqueuedAt,
      queuedPos: q.position,
    });
  }
  return out;
}
