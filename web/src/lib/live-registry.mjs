// 通用「在跑登记表」工厂（工单 generate-tailored-cv/04）。
//
// 这张表原本内联在 checkup-live.mjs 里（ADR-0033 决议 2/6）。定制简历 worker 需要同样的
// 护栏——「同一个 tracker# 此刻有没有生成在跑」——且语义逐字一致（queued/running 两态、
// run 终态即放开闸门、进程真死才算 gone、settling 墓碑兜底）。与其复制一份会漂移的副本，
// 这里把它抽成工厂：checkup 与 tailor 各持一个独立实例（各自的 tracker# 空间互不污染），
// 共享的只是同一份正确逻辑。
//
// 抽出后 checkup-live.mjs 变成对这层的一层薄命名封装，对外 API 与契约一字未改
// （web/tests/lib/checkup-live.test.mjs 是它的回归锁）。
//
// Plain .mjs + 依赖无外部：`node --test` 直接可锁，不 import TS。

/**
 * @typedef {{ runId: string, state: "queued" | "running", startedAt: number | null }} LiveSnapshot
 * @typedef {{ runId: string, state: "queued" | "running", startedAt: number | null,
 *   gone: boolean, resolveGone: () => void, gonePromise: Promise<void> }} LiveEntry
 */

/**
 * 建一个进程内在跑登记表实例。内存态，重启即清——被重启清掉的在跑任务，下一次派发直接再来一个。
 * @param {{ maxSettling?: number }} [opts] — settling 墓碑上限（防杀不掉的僵尸进程把表撑爆）。
 */
export function createLiveRegistry({ maxSettling = 64 } = {}) {
  /** tracker# → 该行的在跑条目（列表：极端并发下同 tracker# 允许短暂多条，替换据此停全部）。 */
  const byTracker = new Map();
  /** runId → 已离开在跑列表、但进程还没确认死掉的条目（等死用；超出上限淘汰最老的）。 */
  const settling = new Map();

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
    if (settling.size > maxSettling) {
      const oldest = settling.keys().next();
      if (!oldest.done) settling.delete(oldest.value);
    }
    entry.gonePromise.then(() => settling.delete(runId));
  }

  return {
    /** 登记一次派发（进入并发池之前，初始 queued）。同 (tracker#, runId) 幂等。 */
    register(tracker, runId) {
      const list = bucket(tracker, true);
      if (!list || !runId) return;
      if (list.some((e) => e.runId === runId)) return;
      let resolveGone;
      const gonePromise = new Promise((res) => {
        resolveGone = res;
      });
      list.push({ runId, state: "queued", startedAt: null, gone: false, resolveGone, gonePromise });
    },

    /** 拿到池槽、CLI 即将 spawn：queued → running，记开始时刻。条目已清除时 no-op。 */
    markRunning(tracker, runId, now = Date.now()) {
      const entry = findLive(tracker, runId);
      if (!entry) return;
      entry.state = "running";
      entry.startedAt = now;
    },

    /** run 终态时移出在跑列表（闸门立刻放开）。processGone=true 直接 gone；否则进墓碑等退出信号。 */
    clear(tracker, runId, { processGone = false } = {}) {
      const list = bucket(tracker);
      if (!list) return;
      const idx = list.findIndex((e) => e.runId === runId);
      if (idx === -1) return;
      const [entry] = list.splice(idx, 1);
      if (list.length === 0) byTracker.delete(normalize(tracker));
      if (processGone) markGone(entry);
      else settleTombstone(runId, entry);
    },

    /** 本行此刻在跑的全部条目（快照拷贝）——前哨的判据。 */
    list(tracker) {
      const list = bucket(tracker);
      if (!list) return [];
      return list.map(({ runId, state, startedAt }) => ({ runId, state, startedAt }));
    },

    /** 把某次运行的子进程退出信号交给登记表（spawn 后调用）。已 gone / 已清除时 no-op。 */
    attachExit(tracker, runId, exitPromise) {
      const entry = findLive(tracker, runId) ?? settling.get(runId) ?? null;
      if (!entry || entry.gone) return;
      if (!exitPromise || typeof exitPromise.then !== "function") return;
      exitPromise.then(
        () => markGone(entry),
        () => markGone(entry),
      );
    },

    /** 等某次运行的进程真不在（替换路径前置）。gone=确认不在；unknown=表里没这条; timeout=不确定。 */
    async awaitGone(tracker, runId, timeoutMs = 5000) {
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
    },

    /** 测试钩子：清空两张表（非运行时接口）。 */
    __reset() {
      byTracker.clear();
      settling.clear();
    },
  };
}
