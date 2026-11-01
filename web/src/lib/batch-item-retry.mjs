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
 *
 * ADR-0093 修订 1（2026-11-01）：`item-running` 占位与「结论丢失」同形——父批量的
 * 流断掉（连接错误 / 进程被关）时，在跑那一条永远收不到终态 `item` 事件，卡片
 * 停在 ok=false 且没有 reason 的占位上，而父卡已终态。此前一律按「仍在跑」拒绝
 * 重试，于是用户看到一条失败项却没有任何补救入口。现在由调用方把父卡终态传进来，
 * 终态批量的无 reason 失败项按「结论丢失」放行；父卡仍在跑时口径不变。
 */

/**
 * 一个子项当前能否发起重试。
 * 规则（ADR-0093 决议 1 + 修订 1）：`ok === false` 且未跳过（skipped 不算失败，
 * ADR-0041 决议 5）、且 key 是 http(s) URL（checkup 的 tracker# 与畸形 key 一律
 * 拒绝）；失败原因方面——有非空 reason 直接放行（服务端对终态失败项一定下发），
 * 没有 reason 的 `item-running` 占位只有在父批量已终态（`parentTerminal`）时才
 * 视为「结论丢失」放行，父卡仍在跑则继续拒绝（免得与在跑的 worker 重复消费）。
 * 判不了就 false。
 *
 * @param {{ key?: string, ok?: boolean, skipped?: boolean, reason?: string } | null | undefined} item
 * @param {{ parentTerminal?: boolean }} [opts] - parentTerminal = 父批量已达终态
 *   （done/error，含刷新后按 interrupted 猜标的卡）。缺省 false＝与旧行为一致。
 * @returns {boolean}
 */
export function canRetryBatchItem(item, { parentTerminal = false } = {}) {
  if (!item || typeof item.key !== "string" || item.key.length === 0) return false;
  if (item.ok) return false;
  if (item.skipped) return false;
  const hasReason = typeof item.reason === "string" && item.reason.trim().length > 0;
  if (!hasReason && parentTerminal !== true) return false;
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