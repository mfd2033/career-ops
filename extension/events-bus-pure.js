// events-bus-pure.js — 共享事件通道的分发判定层（ADR-0020 的扩展侧对齐）。
//
// 为什么存在：服务端的 /api/events 本来就是**一条连接多路复用所有 run** 的总线
// （帧形如 `{runId, ev}`，ev 带单调 `seq`）。改造前扩展没吃这个设计——每次单职位
// 评估各自 fetch 一条 /api/events，每批评估各占一条 /api/batch-evaluate。浏览器对
// 同一 origin 只有 6 条 HTTP/1.1 连接：几条评估叠上加 18s 的快评，池子就满了，连
// `/api/version` 探针都只能在队尾等自己的 abort 计时 —— popup 报「本地服务在忙」，
// 而服务 1-3ms 就能答（实测：6 条占满后 primary 6001ms timeout / retry 4000ms
// timeout，池外裸连接 3ms ok）。
//
// 本文件只做三件纯事（同 probe-pure.js 口径）：
//   • createBus      —— 按 runId 分发、缓冲回放、seq 去重、错误广播；
//   • isRunFrame     —— 一帧是否值得分发；
//   • （连接本身、重连、空闲看门狗留在 background.js，它们要 chrome/fetch。）
//
// background.js 以经典 service worker 方式 importScripts 本文件，经
// self.__careerOpsEventsBusPure 取用；node 单测以 module.exports 守卫直接 import。
// 本文件严禁引用 chrome/window/document/fetch —— 只做分发判定，不发请求。

(function () {
  "use strict";

  // 记录上限：只为「通道已连、订阅者还没到」的那点窗口留回放余量，
  // 不是长期缓存。超限时先淘汰最旧的无订阅者记录。
  const DEFAULT_MAX_RUNS = 8;
  const DEFAULT_MAX_FRAMES_PER_RUN = 300;

  /**
   * 一帧是否是要分发的 run 事件。
   * keepalive（`{type:"keepalive"}`，通道心跳）与畸形帧都不算。
   *
   * @param {unknown} frame
   * @returns {boolean}
   */
  function isRunFrame(frame) {
    if (!frame || typeof frame !== "object") return false;
    if (typeof frame.runId !== "string" || !frame.runId) return false;
    return !!frame.ev && typeof frame.ev === "object";
  }

  /**
   * 建一条分发表。
   *
   * @param {{maxRuns?:number, maxFramesPerRun?:number}} [opts]
   */
  function createBus({ maxRuns = DEFAULT_MAX_RUNS, maxFramesPerRun = DEFAULT_MAX_FRAMES_PER_RUN } = {}) {
    // runId → { buffer: object[], lastSeq: ?number }（Map 的插入顺序就是淘汰顺序）
    const records = new Map();
    // runId → Set<handler>
    const subscribers = new Map();

    function ensureRecord(runId) {
      let rec = records.get(runId);
      if (rec) return rec;
      rec = { buffer: [], lastSeq: null };
      records.set(runId, rec);
      reapIfOverCap();
      return rec;
    }

    function reapIfOverCap() {
      if (records.size <= maxRuns) return;
      // 先淘汰「没有订阅者」的最旧记录；都有人订就退而求其次动最旧的。
      for (const [runId, rec] of records) {
        if (records.size <= maxRuns) return;
        const watched = (subscribers.get(runId) || { size: 0 }).size > 0;
        if (!watched) records.delete(runId);
      }
      for (const runId of records.keys()) {
        if (records.size <= maxRuns) return;
        records.delete(runId);
      }
    }

    function deliver(runId, frame) {
      const set = subscribers.get(runId);
      if (!set || set.size === 0) return 0;
      for (const handler of set) {
        try {
          handler(frame);
        } catch {
          // 单个订阅者抛错不能拖垮其他评估的分发。
        }
      }
      return set.size;
    }

    /**
     * 收到一帧。返回 "keepalive" / "ignored" / "duplicate" / "delivered"。
     *
     * 去重的依据是服务端盖的单调 `seq`：通道断开重连时服务端会整段回放，
     * 没有这层去重，正在跑的评估会重放一遍已走过的步骤。
     */
    function publish(frame) {
      if (frame && frame.type === "keepalive") return "keepalive";
      if (!isRunFrame(frame)) return "ignored";
      const rec = ensureRecord(frame.runId);
      const seq = frame.ev.seq;
      if (typeof seq === "number" && Number.isFinite(seq)) {
        if (rec.lastSeq != null && seq <= rec.lastSeq) return "duplicate";
        rec.lastSeq = seq;
      }
      rec.buffer.push(frame);
      if (rec.buffer.length > maxFramesPerRun) rec.buffer.splice(0, rec.buffer.length - maxFramesPerRun);
      deliver(frame.runId, frame);
      return "delivered";
    }

    /**
     * 订阅某条 run 的事件；返回退订函数。
     *
     * 订阅前已到达的帧会先回放一遍：正常路径是「先 POST /api/run 拿 runId、再订阅」，
     * 那几帧本来会丢。多订阅者时每个新订阅者也各拿一份回放，这是有意的。
     */
    function subscribe(runId, handler) {
      if (typeof runId !== "string" || !runId || typeof handler !== "function") return () => {};
      const set = subscribers.get(runId) || new Set();
      subscribers.set(runId, set);
      const rec = records.get(runId);
      if (rec) {
        for (const frame of rec.buffer) {
          try {
            handler(frame);
          } catch {
            /* 回放期间的异常同样只影响这个订阅者 */
          }
        }
      }
      set.add(handler);
      return function unsubscribe() {
        const cur = subscribers.get(runId);
        if (!cur) return;
        cur.delete(handler);
        if (cur.size === 0) subscribers.delete(runId);
      };
    }

    /** 通道级故障：把同一个错误发给每个在场订阅者（订阅关系保留，重连后继续用）。 */
    function failAll(error) {
      const frame = { error: String(error == null ? "事件通道异常" : error) };
      for (const set of subscribers.values()) {
        for (const handler of set) {
          try {
            handler(frame);
          } catch {
            /* 同上 */
          }
        }
      }
    }

    function subscriberCount() {
      let total = 0;
      for (const set of subscribers.values()) total += set.size;
      return total;
    }

    return {
      publish,
      subscribe,
      failAll,
      subscribers: subscriberCount,
      runs: () => records.size,
      maxRuns,
      maxFramesPerRun,
    };
  }

  const api = { createBus, isRunFrame };

  // service worker（经典脚本，background.js 经 importScripts 引入）：挂 self。
  if (typeof self !== "undefined" && self && !self.__careerOpsEventsBusPure) {
    self.__careerOpsEventsBusPure = api;
  }
  // node 单测：module.exports 守卫（同 probe-pure.js 口径）。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
