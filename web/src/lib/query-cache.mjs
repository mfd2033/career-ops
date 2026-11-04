// query-cache.mjs — 「同一份输入 → 同一次子进程」的缓存 + 合并层（ADR-0098 决议 4/5）。
//
// WHY: `/api/tracker` 是 `tracker.mjs query --json` 的壳，每个请求 spawn 一个
// Node 子进程（实测 411ms）。页面一次刷新会打好几次，托盘/扩展也在同时探活；并发
// 起来就是若干个 Node 启动撞在同一个单线程事件循环上。
//
// 两层合在一起才有意义：
//   • **签名失效**：`signatureOf()` 变了（applications.md 的 mtime+size）就整代作废
//     ——文件没变，行的答案就没变；变了，立刻重建，不需要谁记得"刷新"。
//   • **合并（single-flight）**：同一把 key 在飞时，后来者共享那一个 Promise，而不是
//     再 spawn 一个。
//
// 刻意不做 TTL（ADR-0098 Alternatives）：tracker 是用户正在写的文件，"刚改完列表
// 还是旧的"比"多跑一次子进程"糟得多。
//
// `maxEntries` 只是安全阀：key 里带着筛选条件，长时间开着页面会攒出不同组合；
// 满了就按插入顺序淘汰最老的一条。

/**
 * @template T
 * @param {object} options
 * @param {() => Promise<string>} options.signatureOf 输入签名（变了就整代作废）
 * @param {(value: T) => boolean} [options.isCacheable] 只缓存成功且完整的值（默认全缓）
 * @param {number} [options.maxEntries] 安全阀：条目上限，超出淘汰最老的
 * @returns {{ get: (key: string, run: () => Promise<T>) => Promise<T>, invalidate: () => void, stats: () => {entries: number, inflight: number, generation: number} }}
 */
export function createQueryCache({ signatureOf, isCacheable = () => true, maxEntries = 64 } = {}) {
  if (typeof signatureOf !== "function") throw new TypeError("createQueryCache: signatureOf 必须是函数");
  if (typeof isCacheable !== "function") throw new TypeError("createQueryCache: isCacheable 必须是函数");

  /** @type {Map<string, T>} */
  const done = new Map();
  /** @type {Map<string, Promise<T>>} */
  const inflight = new Map();
  /** @type {string|null} */
  let signature = null;
  // 世代号：签名一变就 +1。旧世代在飞的 Promise 回来时不许把结果写进新世代的缓存，
  // 否则"改完文件 → 旧查询落地"会让新数据被旧结果覆盖。
  let generation = 0;

  function dropAll() {
    signature = null;
    generation += 1;
    done.clear();
    inflight.clear();
  }

  return {
    /**
     * 取这份输入对应的值；未命中就执行 `run`（同一 key 并发只执行一次）。
     * 失败**不缓存**：超时/子进程报错是环境状态，不是"输入没变"的结论。
     *
     * @param {string} key 输入的身份（argv 拼成的稳定串）
     * @param {() => Promise<T>} run 真正干活的那次调用
     * @returns {Promise<T>}
     */
    async get(key, run) {
      const current = await signatureOf();
      if (current !== signature) {
        signature = current;
        generation += 1;
        done.clear();
        inflight.clear();
      }
      if (done.has(key)) return done.get(key);
      const running = inflight.get(key);
      if (running) return running;

      const myGeneration = generation;
      const promise = Promise.resolve()
        .then(run)
        .then((value) => {
          if (myGeneration === generation && isCacheable(value)) {
            if (done.size >= maxEntries) {
              const oldest = done.keys().next().value;
              if (oldest !== undefined) done.delete(oldest);
            }
            done.set(key, value);
          }
          return value;
        })
        .finally(() => {
          if (inflight.get(key) === promise) inflight.delete(key);
        });
      inflight.set(key, promise);
      return promise;
    },
    /** 写路径后主动作废（不需要理由——签名本来也会变，这里只是抢在那之前）。 */
    invalidate() {
      dropAll();
    },
    /** 诊断/测试用。 */
    stats() {
      return { entries: done.size, inflight: inflight.size, generation };
    },
  };
}
