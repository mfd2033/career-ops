/**
 * 批量评估失败子项的重试判定 — 纯函数，零 DOM 依赖，客户端可导入
 * （.mjs 供 node --test 锁定，同 job-retry.mjs 模式）。
 *
 * ADR-0093：batch-evaluate 的子项里，终态失败项可一键作为**独立单任务工作器**
 * 重跑（kind=evaluate、input=URL）。父批量的 items 是历史结论，不反写——失败
 * 证据原样保留，重试在台账里是一条新记录。
 *
 * 只对 evaluate 批量开放：checkup 子项的 key 是 tracker#，单次体检必须先过
 * `/api/checkup-request` 前哨（no-via 门、同 tracker# 在跑去重），绕过它等于
 * 给用户一条静默重入通道，故不在本期范围。
 */

/**
 * 一个子项当前能否发起重试。
 * 规则（ADR-0093 决议 1）：`ok === false` 且未跳过（skipped 不算失败，
 * ADR-0041 决议 5）、有终态失败原因（服务端对终态失败项一定下发 reason；
 * `item-running` 占位同样是 ok=false，但没有 reason，必须排除）、且 key 是
 * http(s) URL（checkup 的 tracker# 与畸形 key 一律拒绝）。判不了就 false。
 *
 * @param {{ key?: string, ok?: boolean, skipped?: boolean, reason?: string } | null | undefined} item
 * @returns {boolean}
 */
export function canRetryBatchItem(item) {
  if (!item || typeof item.key !== "string" || item.key.length === 0) return false;
  if (item.ok) return false;
  if (item.skipped) return false;
  if (typeof item.reason !== "string" || item.reason.trim().length === 0) return false;
  return isHttpUrl(item.key);
}

/**
 * 同 URL 是否已有一张 running/queued 的 evaluate 卡——用于防重复派发（决议 4）。
 * 只看本浏览器的本地卡；池源卡/台账行在别的页签发起时可能漏判，服务端串行与
 * 幂等合并仍兜底，这里只避免同一按钮被连点刷出多张卡。
 *
 * @param {Array<{ kind?: string, input?: string, status?: string }> | null | undefined} jobs
 * @param {string | null | undefined} url
 * @returns {boolean}
 */
export function hasLiveEvaluateForUrl(jobs, url) {
  if (!url) return false;
  return (jobs ?? []).some(
    (j) => j && j.kind === "evaluate" && j.input === url && (j.status === "running" || j.status === "queued"),
  );
}

/** @param {string} s */
function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}