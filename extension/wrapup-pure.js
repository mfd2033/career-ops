// wrapup-pure.js — 扫描收尾的纯逻辑层（ADR-0007 E9）。
//
// 承载三类可脱离浏览器单测的判定，把「本次扫描结束了没有 / 要不要切焦点 / 要停哪些采集 /
// 哪些采集已经死了」从 background.js 的事件回调里剥出来：
//   • decideWrapUp            —— 某条驱动的采集结束（content 发来 scan-done，或该采集
//                                tab 被关闭）后，本次扫描是否已经全部结束、要不要把焦点
//                                切回探索页；
//   • decideAfterExploreGone  —— 探索页 tab 被关闭时的中止动作（停所有仍在跑的采集）；
//   • decideDeadDrives        —— 存活探测的结果里，哪些登记已经静默死亡（反爬跳走）。
//
// 之所以要抽出来：扩展后台是 MV3 service worker，上面这些分支（多平台/拆词/中途关 tab/
// 全平台启动失败/开关关掉）在真实浏览器里几乎没法稳定复现，只有纯函数才测得起。
//
// background.js 以经典 service worker 方式 importScripts 本文件，经
// self.__careerWrapupPure 取用；node 单测以 module.exports 守卫直接 import（与
// scan-pure.js / site-*.js 同口径）。本文件严禁引用 chrome/window/document/location ——
// service worker 里没有 window，加载即崩。

(function () {
  "use strict";

  /** 判定结果的 reason —— 供后台打一行日志解释"为什么这次没切回"。 */
  const REASON = {
    /** 本次扫描还有别的驱动在采（拆词扫描下同 scanId 有多条驱动）。 */
    STILL_ACTIVE: "still-active",
    /** 没有 scanId 就无从归口，也不该记幂等账。 */
    NO_SCAN_ID: "no-scan-id",
    /** 同一 scanId 已经收尾过（连点/重放/迟到的 scan-done）。 */
    ALREADY: "already-wrapped",
    /** 收尾开关关闭（配置页）。 */
    DISABLED: "wrapup-disabled",
    /** 探索页 tab 不可用（用户已经关掉它，或从未记录到）。 */
    NO_EXPLORE_TAB: "no-explore-tab",
    /** 真的切了焦点。 */
    ACTIVATED: "activated",
  };

  /**
   * 一条驱动的采集结束后：本次扫描是否已经全部结束，以及要不要把焦点切回探索页。
   *
   * 「结束了没有」按 scanId 归口——只看属于本次 scanId 的登记。两个理由：
   *   ① 拆词扫描（猎聘一个关键词一条搜索 URL）下同 scanId 有多条驱动，任何一条还在跑
   *      就都还没结束；
   *   ② 别的 scanId 的残留登记（极端情况下 tab 消失得连 onRemoved 都没赶上）不该把
   *      本次扫描永远压住。
   *
   * @param {object} input
   * @param {Array<{key?: string, scanId?: string}>} input.drives 摘掉刚结束的那条登记
   *   **之后**，登记表里剩下的全部登记（可能含别的 scanId 的残留，本函数自行归口）
   * @param {string|null} input.scanId 刚结束的那条驱动所属的扫描 id
   * @param {boolean} input.wrapUpEnabled 配置页收尾开关
   * @param {number|null} input.exploreTabId 发起本次扫描的探索页 tab（不可用时为 null）
   * @param {Iterable<string>} [input.wrappedUpScans] 已收尾过的 scanId
   * @returns {{settle: boolean, scanId: string|null, activateTabId: number|null, reason: string}}
   *   settle = 「把这次扫描标记为已收尾」，调用方据此记 scanId；
   *   activateTabId = 要设为 active 的 tab（null = 不切，但 settle 仍可能为 true）。
   */
  function decideWrapUp({ drives, scanId, wrapUpEnabled, exploreTabId, wrappedUpScans } = {}) {
    const sid = typeof scanId === "string" && scanId.trim() ? scanId.trim() : null;
    const idle = { settle: false, scanId: null, activateTabId: null, reason: REASON.STILL_ACTIVE };
    if (!sid) return { ...idle, reason: REASON.NO_SCAN_ID };

    const list = Array.isArray(drives) ? drives : [];
    if (list.some((d) => d && d.scanId === sid)) return idle;

    const seen = wrappedUpScans || [];
    for (const prev of seen) if (prev === sid) return { ...idle, reason: REASON.ALREADY };

    // 走到这里 = 本次扫描的收尾判定已消费，无论最终有没有真的切焦点都要记 scanId，
    // 否则迟到的 scan-done 会把同一次扫描再判一遍。
    const done = { settle: true, scanId: sid, activateTabId: null };
    if (!wrapUpEnabled) return { ...done, reason: REASON.DISABLED };
    if (exploreTabId == null) return { ...done, reason: REASON.NO_EXPLORE_TAB };
    return { ...done, activateTabId: exploreTabId, reason: REASON.ACTIVATED };
  }

  /**
   * 探索页 tab 被关闭：结果已无处展示（结果只活在原 tab 的 React state 与 per-tab
   * sessionStorage 里），继续采只是浪费——停掉所有仍在跑的采集。已采到的由内容脚本收尾
   * 时照常上报落库，本判定不负责丢弃数据。
   *
   * 不接收入参开关，也不按 scanId 归口：这里要的是「全都停」，不是「本次停止」
   * （ADR-0007 E9）。
   *
   * @param {{drives: Array<{key?: string, tabId?: number}>}} input
   * @returns {{stopTabIds: number[], clearKeys: string[]}}
   */
  function decideAfterExploreGone({ drives } = {}) {
    const list = Array.isArray(drives) ? drives : [];
    const stopTabIds = [];
    const clearKeys = [];
    for (const d of list) {
      if (!d) continue;
      if (typeof d.tabId === "number" && stopTabIds.indexOf(d.tabId) === -1) stopTabIds.push(d.tabId);
      if (typeof d.key === "string" && d.key && clearKeys.indexOf(d.key) === -1) clearKeys.push(d.key);
    }
    return { stopTabIds, clearKeys };
  }

  /**
   * 采集端存活判定（ADR-0007 E10）：登记里哪些驱动已经静默死亡。
   *
   * 反爬把采集 tab 整页跳到验证页/换域名时，content script 连同它的定时器一起被销毁，
   * `scan-done` 永远发不出来 —— 登记一直留着，收尾也永不触发。所以由后台主动探活，
   * 本函数只负责把「探测结果」翻成「哪些该按结束处理」。
   *
   * 判定（fail-closed）：
   *   • 还没完成启动握手（started 非真）→ **不**判死：此时内容脚本可能尚未注入，
   *     无应答是正常的，这一段窗口必须让开；
   *   • 明确答「活着」（alive === true）→ 不判死；
   *   • 明确答「不在采集」或无应答（sendMessage 抛错、tab 上内容脚本被换掉）→ 判死。
   * 最后一条是刻意的 fail-closed：漏判会让收尾永远不触发（本函数要修的就是这个），
   * 误判的代价只是提前收尾——停采集 + 切回探索页，用户可重扫，不丢已采数据。
   *
   * @param {object} input
   * @param {Array<{key?: string, scanId?: string, started?: boolean}>} input.drives 登记快照
   * @param {Array<{key?: string, alive?: boolean}>} input.probes 每条已探测登记的结果
   *   （只该包含 started 的登记；缺项按无应答处理）
   * @returns {{deadKeys: string[], scanId: string|null}} deadKeys 要摘的登记；
   *   scanId = 死掉登记里第一个非空 scanId（登记共享同一次扫描，取一个即可归口）
   */
  function decideDeadDrives({ drives, probes } = {}) {
    const answers = new Map();
    for (const p of Array.isArray(probes) ? probes : []) {
      if (p && typeof p.key === "string" && p.key) answers.set(p.key, p.alive === true);
    }
    const deadKeys = [];
    let scanId = null;
    for (const d of Array.isArray(drives) ? drives : []) {
      if (!d || typeof d.key !== "string" || !d.key) continue;
      if (!d.started) continue;
      if (answers.get(d.key) === true) continue;
      deadKeys.push(d.key);
      if (!scanId && typeof d.scanId === "string" && d.scanId) scanId = d.scanId;
    }
    return { deadKeys, scanId };
  }

  const api = { REASON, decideWrapUp, decideAfterExploreGone, decideDeadDrives };

  // service worker（经典脚本，background.js 经 importScripts 引入）：挂 self。
  // 内容脚本里 self === window，同一行也成立。
  if (typeof self !== "undefined" && self && !self.__careerWrapupPure) {
    self.__careerWrapupPure = api;
  }
  // node 单测：module.exports 守卫（同 scan-pure.js 口径）。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
