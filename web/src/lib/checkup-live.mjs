// 体检在跑登记表（checkup live registry）—— ADR-0033 决议 2/6。
//
// WHY THIS EXISTS: 「tracker# N 此刻有没有体检在跑」必须在本浏览器之外也成立，可现成
// 的三个来源都答不了：本地 jobs store 只看得见本页签的卡片；run ledger
// (run-ledger.mjs) 只记 TERMINATED 的 run；并发池条目没有 kind（而且 batch 与浏览器
// 扩展共用它，不该为一个只服务 checkup 的判定放宽池语义）。所以这里是一个**单用途**
// 的进程内登记：派发时按 tracker# 写入，run 终态时清除。
//
// 两种状态都算「在体检」：queued（已派发、还在等并发槽，CLI 尚未 spawn）与 running
// （拿到槽、CLI 在跑）。排队中的体检按钮必须被拦下 —— 而且它是最便宜的一次取消
// （直接出队，不用杀进程）。
//
// 「run 终态」与「进程已死」是两件事（决议 6）: terminateCli 是 fire-and-forget
// （spawn-cli.mjs 的 taskkill 发完即返回），所以取消一个正在跑的体检时，run 已经记
// 终态、可进程还在喘气。替换动作（停旧的、派新的）必须先确认旧的真的退出——否则同一
// 份 HTML（reports/checkups/{tracker#}-{slug}-{date}.html）与同一份报告附录会短暂出
// 现两个写入方。于是登记表把两件事分开：
//   - 在跑列表（listLiveCheckups / 前哨的判据）：run 一到终态就干净，闸门立刻放开；
//   - gone 信号（awaitCheckupGone）：只有**进程**的退出信号（或排队中被取消，本来就
//     没有进程）才算「不在了」。条目已被清除但还没确认死掉时，登记表把它留在
//     settling 墓碑里继续等——超时是「不确定」，不是「已死」，调用方据此决定要不要
//     把不确定说出来。
//
// 内存态，重启即清（与并发池、活跃运行视图同语义，ADR-0014 Q8）；不做持久化——被
// 重启清掉的在跑体检，下一次按下直接再派一个即可。
//
// Plain .mjs（同 job-ledger-reconcile.mjs）：node --test 锁定，不 import tsx。

/**
 * 一次体检运行的进程内登记。`gone` 是「进程已经不在了」的信号，与「run 是否还在进行」
 * 分开（见文件头）。
 * @typedef {{
 *   runId: string,
 *   state: "queued" | "running",
 *   startedAt: number | null,
 *   gone: boolean,
 *   resolveGone: () => void,
 *   gonePromise: Promise<void>,
 * }} CheckupLiveEntry
 */

/** @typedef {{runId: string, state: "queued" | "running", startedAt: number | null}} CheckupLiveSnapshot */

/** tracker# → 该行的在跑条目。列表（而非单条）是因为极端并发下同一 tracker# 允许短暂
 *  出现多条，替换动作据此「停全部」（ADR-0033 决议 3）。 */
const byTracker = new Map();

/** runId → 已离开在跑列表、但进程还没确认死掉的条目（等死用）。runId 是 UUID，全局唯一。
 *  有界：kill 不掉且永不退出的进程不该让登记表无限长大（超出即淘汰最老的墓碑——
 *  之后的等待返回 unknown，按「已停」处理，等同于没有登记表时的行为）。 */
const settling = new Map();
const MAX_SETTLING = 64;

function normalize(tracker) {
  return String(tracker ?? "").trim();
}

function bucket(tracker, create = false) {
  const k = normalize(tracker);
  if (!k) return null;
  let list = byTracker.get(k);
  if (!list && create) {
    list = [];
    byTracker.set(k, list);
  }
  return list ?? null;
}

function findLive(tracker, runId) {
  const list = bucket(tracker);
  if (!list) return null;
  return list.find((e) => e.runId === runId) ?? null;
}

function markGone(entry) {
  if (entry.gone) return;
  entry.gone = true;
  entry.resolveGone();
}

function settleTombstone(runId, entry) {
  settling.set(runId, entry);
  if (settling.size > MAX_SETTLING) {
    const oldest = settling.keys().next();
    if (!oldest.done) settling.delete(oldest.value);
  }
  // 确认死掉后墓碑即可退休（此时所有已开始的等待都已经拿到同一个 promise）。
  entry.gonePromise.then(() => settling.delete(runId));
}

/**
 * 登记一次体检派发。登记发生在进入并发池**之前**，所以初始状态是 queued。
 * 同 (tracker#, runId) 重复登记是幂等的（保留最先那条，不重置它的 gone 信号）。
 * @param {string|number} tracker
 * @param {string} runId
 * @returns {void}
 */
export function registerCheckup(tracker, runId) {
  const list = bucket(tracker, true);
  if (!list || !runId) return;
  if (list.some((e) => e.runId === runId)) return;
  let resolveGone;
  const gonePromise = new Promise((res) => {
    resolveGone = res;
  });
  list.push({ runId, state: "queued", startedAt: null, gone: false, resolveGone, gonePromise });
}

/**
 * 并发池发放槽位、CLI 即将 spawn 时调用：queued → running，并记下开始时刻。
 * 条目已被清除时是 no-op（run 在排队阶段就被取消的情形）。
 * @param {string|number} tracker
 * @param {string} runId
 * @param {number} [now]
 * @returns {void}
 */
export function markCheckupRunning(tracker, runId, now = Date.now()) {
  const entry = findLive(tracker, runId);
  if (!entry) return;
  entry.state = "running";
  entry.startedAt = now;
}

/**
 * run 走到终态（done / error / 取消）时把条目移出在跑列表 —— 幂等，未知条目是 no-op。
 * 闸门（前哨）据此立刻放开，所以这一步不能等进程确认死掉。
 * @param {string|number} tracker
 * @param {string} runId
 * @param {{processGone?: boolean}} [opts] — 终态时进程是否已确认不在。CLI 已 close、
 *        排队中被取消（本就没有进程）→ true；取消一个正在跑的 run（taskkill 是
 *        fire-and-forget）→ false，条目进 settling 等退出信号。
 * @returns {void}
 */
export function clearCheckup(tracker, runId, { processGone = false } = {}) {
  const list = bucket(tracker);
  if (!list) return;
  const idx = list.findIndex((e) => e.runId === runId);
  if (idx === -1) return;
  const [entry] = list.splice(idx, 1);
  if (list.length === 0) byTracker.delete(normalize(tracker));
  if (processGone) markGone(entry);
  else settleTombstone(runId, entry);
}

/**
 * 本行此刻在跑的全部体检（快照拷贝）—— 前哨的判据。
 * @param {string|number} tracker
 * @returns {CheckupLiveSnapshot[]}
 */
export function listLiveCheckups(tracker) {
  const list = bucket(tracker);
  if (!list) return [];
  return list.map(({ runId, state, startedAt }) => ({ runId, state, startedAt }));
}

/**
 * 把某次运行的子进程退出信号交给登记表（run route 在 spawn 后调用）。子进程正常退出、
 * 被杀、或 spawn 失败都会 resolve，都算「不在了」。条目已被清除或已 gone 时是 no-op。
 * @param {string|number} tracker
 * @param {string} runId
 * @param {Promise<unknown> | null | undefined} exitPromise
 * @returns {void}
 */
export function attachCheckupExit(tracker, runId, exitPromise) {
  const entry = findLive(tracker, runId) ?? settling.get(runId) ?? null;
  if (!entry || entry.gone) return;
  if (!exitPromise || typeof exitPromise.then !== "function") return;
  exitPromise.then(
    () => markGone(entry),
    () => markGone(entry),
  );
}

/**
 * 等某次运行的进程真的不在了（替换路径的前置条件，ADR-0033 决议 6）。
 * @param {string|number} tracker
 * @param {string} runId
 * @param {number} [timeoutMs] — 默认 5000（决议 3 的兜底窗口）。
 * @returns {Promise<"gone"|"unknown"|"timeout">} gone = 确认不在；unknown = 登记表里
 *          没有这条（run 从未登记、或早已结束并清除，按已停处理）；timeout = 超时
 *          未确认——调用方必须把它当「不确定」，而不是「已死」。
 */
export async function awaitCheckupGone(tracker, runId, timeoutMs = 5000) {
  const entry = findLive(tracker, runId) ?? settling.get(runId) ?? null;
  if (!entry) return "unknown";
  if (entry.gone) return "gone";
  let timer;
  const timeout = new Promise((res) => {
    timer = setTimeout(() => res("timeout"), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([entry.gonePromise.then(() => "gone"), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// --- test hooks (unit tests only; not part of the runtime surface) ----------

export function __resetCheckupLiveForTest() {
  byTracker.clear();
  settling.clear();
}
