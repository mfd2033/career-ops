/**
 * 工作器任务重试的判定与重置逻辑 — 纯函数，零 DOM 依赖，客户端可导入
 * （.mjs 供 node --test 锁定，同 row-click.mjs / inbox-url.mjs 模式）。
 *
 * ADR-0061：失败（error 终态）的本地卡可手动重试——原卡复用、attempt+1、
 * 整卡重跑（批量已成功项接受重复执行）。重试的取参来源是卡上的派发参数
 * 快照：单任务凭 kind+input，批量凭 urls/ns（items 只是结论清单、可能被
 * cap 截断，不能反推原始清单）。池源卡（active-*）与 ledger-only 行没有
 * 完整参数，永远不可重试。
 */

/** 批量任务的 kind——它们的派发参数是 urls/ns 而非单个 input。 */
export const BATCH_JOB_KINDS = Object.freeze(["batch-evaluate", "batch-checkup"]);

/**
 * 这张卡当前能否发起重试。
 * 规则（ADR-0061 决议 4/8）：仅本地卡（id 以 `job-` 开头）且 status === "error"
 * （含跨会话恢复的 interruptedAt 卡）；批量卡必须留有非空 urls/ns 快照，
 * 单任务卡必须留有 kind+input。取消/完成不提供入口；判不了就 false。
 *
 * @param {{ id?: string, status?: string, kind?: string, input?: string, urls?: string[], ns?: string[] } | null | undefined} job
 * @returns {boolean}
 */
export function canRetryJob(job) {
  if (!job || typeof job.id !== "string" || !job.id.startsWith("job-")) return false;
  if (job.status !== "error") return false;
  if (BATCH_JOB_KINDS.includes(job.kind)) {
    return (job.urls?.length ?? 0) > 0 || (job.ns?.length ?? 0) > 0;
  }
  return !!job.kind && !!job.input;
}

/**
 * 下一次尝试的序号——缺省视为第 1 次（功能前创建的旧卡没有 attempt 字段）。
 * @param {{ attempt?: number } | null | undefined} job
 * @returns {number}
 */
export function nextAttempt(job) {
  return (job?.attempt ?? 1) + 1;
}

/**
 * 为重试重置一张卡（原卡复用，ADR-0061 决议 3）：不换 id、不新增卡。
 * 保留展示与派发字段（title/subtitle/page/input/kind/cliId/model/reportNum/
 * batchId/urls/ns），attempt+1、状态回 running、时间线追加「第 N 次尝试」
 * 分隔行后保留旧步骤（STEPS_CAP 滚动窗口自然截断更早的尝试）；上次运行的
 * 运行态与结论（items/batchPos/serverBatchId/text/result/cost/runId/
 * interruptedAt/时间戳/阶段）全部清除，由新 run 重建。
 *
 * @param {Record<string, unknown>} job - 原卡（须已通过 canRetryJob）。
 * @param {{ now: number, separatorLabel: string }} opts - now = 重试发起时刻；
 *   separatorLabel = 分隔行文案（调用方用 i18n 生成，如 t("jobs.retryAttempt", { n })）。
 * @returns {Record<string, unknown>} 重置后的新卡对象（原对象不变）。
 */
export function resetJobForRetry(job, { now, separatorLabel }) {
  return {
    id: job.id,
    title: job.title,
    subtitle: job.subtitle,
    page: job.page,
    input: job.input,
    kind: job.kind,
    cliId: job.cliId,
    model: job.model,
    reportNum: job.reportNum,
    batchId: job.batchId,
    urls: job.urls,
    ns: job.ns,
    attempt: nextAttempt(job),
    status: "running",
    steps: [...(job.steps ?? []), { kind: "status", label: separatorLabel, ts: now }],
    text: "",
    startedAt: now,
  };
}
