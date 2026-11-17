/**
 * 工作器「停止」判定与状态口径 — 纯函数，零 DOM 依赖（.mjs 供 node --test 锁定）。
 *
 * 停止 ≠ 移除：停止把运行中/排队中的卡片落到「用户中断」终态并保留（可重试）；
 * 移除只在终态把卡片从列表拿掉。停止后 status 仍是 error（沿用 ADR-0061 的
 * 可重试判定），`cancelledByUser` 才是「已停止 · 用户中断」的展示与语义来源。
 */

/** 池源投影卡的 id 前缀（与 job-store 的 activeCards 同值）。 */
export const POOL_CARD_PREFIX = "active-";

export function isStopped(job) {
  return job?.cancelledByUser === true;
}

/** 进行中 = 还有东西可停。终态（done/error）只可移除或重试。 */
export function isJobActive(job) {
  return job?.status === "running" || job?.status === "queued";
}

/**
 * 这张卡当前能否停止。
 *
 * 池源投影卡（active- 前缀）没有可持久化的派发快照：
 * - 排队中：可从并发池出队，真停；
 * - 运行中：批量 worker 在服务端没有按 id 可达的取消句柄（单任务已由
 *   adopt- 真卡接管，不走这条投影），因此不提供入口——避免点完只是从列表消失。
 *
 * 本地卡与 adopt 卡都持有真实句柄（/api/run/cancel 的 runId，或批量 NDJSON
 * 流的 AbortController），一律可停。
 */
export function canStopJob(job) {
  if (!isJobActive(job)) return false;
  if (typeof job.id !== "string" || job.id.length === 0) return false;
  if (job.id.startsWith(POOL_CARD_PREFIX)) return job.status === "queued";
  return true;
}

/** 状态列文案的 i18n 键：用户中断优先于通用 error。 */
export function jobStatusLabelKey(job) {
  if (!job) return "jobs.statusError";
  if (isStopped(job)) return "jobs.statusStopped";
  switch (job.status) {
    case "running":
      return "jobs.statusRunning";
    case "queued":
      return "jobs.queued";
    case "done":
      return "jobs.statusDone";
    default:
      return "jobs.statusError";
  }
}
/**
 * 这张卡当前能否从列表移除。
 *
 * 只有终态卡可移除：进行中的卡要先停止（移除一个还在跑的任务是两件事混成
 * 一个动作，正是本次要改掉的）。纯台账卡（ledgerOnly）不提供移除——它不是
 * 本地状态，删了下次轮询又会被台账合并回来，是个死按钮。
 */
export function canRemoveJob(job) {
  if (!job || job.ledgerOnly === true) return false;
  return job.status === "done" || job.status === "error";
}