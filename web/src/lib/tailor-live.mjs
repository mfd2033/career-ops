// 定制简历在跑登记表（tailor live registry）——工单 generate-tailored-cv/04。
//
// 与 checkup-live 同一条护栏、同一份逻辑（都来自通用工厂 live-registry.mjs），只是各自
// 一具独立实例：tracker# 空间互不污染（同一行同时在体检 + 在生成简历是两件不同的事）。
// 「同一个 offer 此刻有没有定制在跑」必须在本浏览器之外也成立，所以派发时按 tracker# 写入、
// run 终态时清除；替换（replace）先等旧进程真不在再派新的。语义细节见 live-registry.mjs 与
// ADR-0033 决议 2/6。
//
// Plain .mjs：node --test 锁定，不 import tsx。

import { createLiveRegistry } from "./live-registry.mjs";

const registry = createLiveRegistry();

/** 登记一次定制派发（进入并发池之前，初始 queued）。同 (tracker#, runId) 幂等。 */
export function registerTailor(tracker, runId) {
  registry.register(tracker, runId);
}

/** 并发池发放槽位、worker 即将起子进程时调用：queued → running。 */
export function markTailorRunning(tracker, runId, now = Date.now()) {
  registry.markRunning(tracker, runId, now);
}

/** run 终态时移出在跑列表（闸门立刻放开）。processGone=进程是否已确认不在。 */
export function clearTailor(tracker, runId, { processGone = false } = {}) {
  registry.clear(tracker, runId, { processGone });
}

/** 本行此刻在跑的全部定制（快照拷贝）——前哨的判据。 */
export function listLiveTailors(tracker) {
  return registry.list(tracker);
}

/** 把某次 run 的 worker 退出信号交给登记表（起子进程后调用）。 */
export function attachTailorExit(tracker, runId, exitPromise) {
  registry.attachExit(tracker, runId, exitPromise);
}

/** 等某次 run 的进程真不在（替换路径前置）。gone / unknown / timeout 语义见工厂。 */
export async function awaitTailorGone(tracker, runId, timeoutMs = 5000) {
  return registry.awaitGone(tracker, runId, timeoutMs);
}

// --- test hooks (unit tests only; not part of the runtime surface) ----------

export function __resetTailorLiveForTest() {
  registry.__reset();
}
