// badge-pure.js — 工具栏连接状态徽章的纯逻辑层（ADR-0050）。
//
// 把两件可脱离浏览器单测的判断从 background.js 的事件回调里剥出来：
//   • decideBadge   —— 这次徽章刷新到底要不要真的重新扫一遍端口（5s 节流 + force 旁路）；
//   • badgeVisual   —— 已知连接布尔 → 徽章文案与底色的映射。
//
// 之所以抽出来：background.js 是 MV3 service worker，节流窗口/force 旁路这些边界
// 在真实浏览器里几乎没法稳定复现，只有纯函数才测得起。
//
// background.js 以经典 service worker 方式 importScripts 本文件，经
// self.__careerOpsBadgePure 取用；node 单测以 module.exports 守卫直接 import（与
// wrapup-pure.js / scan-pure.js 同口径）。本文件严禁引用 chrome/window/document/location
// —— service worker 里没有 window，加载即崩。

(function () {
  "use strict";

  // 底色：连上绿、未连红（二值，版本校验失败按未连处理，无第三态）。
  const BADGE_GREEN = "#16a34a";
  const BADGE_RED = "#dc2626";
  // ✓ 非 ASCII，个别 Chrome 徽章字体下会渲染为空白；若观察到空白，把
  // BADGE_TEXT_CONNECTED 改成 ASCII "ok" 即可（此处是唯一改点，无需动 background）。
  const BADGE_TEXT_CONNECTED = "✓";
  const BADGE_TEXT_DISCONNECTED = "!"; // ASCII，最稳
  // 全端口扫描一次覆盖 3000-3040 共 41 口，不能每次切页都扫；5s 内复用上次结果。
  const BADGE_THROTTLE_MS = 5000;

  /**
   * 决定这次徽章刷新要不要真的重新探测。
   * @param {object}  p
   * @param {number}  p.now           当前时间戳
   * @param {number}  p.lastAt         上次刷新时间戳（0=从未）
   * @param {?boolean} p.lastConnected 上次结果（null=未知）
   * @param {boolean} p.force          是否强制（reprobe/批量结束等明确信号）
   * @param {number}  [p.throttleMs]   节流窗口，默认 BADGE_THROTTLE_MS
   * @returns {{probe:boolean, connected:boolean|null, throttled:boolean}}
   *   - force / 首次（结果未知）/ 距上次 ≥ throttleMs → probe=true, connected=null
   *   - 否则复用上次结果 → probe=false, connected=lastConnected, throttled=true
   */
  function decideBadge({ now, lastAt, lastConnected, force, throttleMs = BADGE_THROTTLE_MS } = {}) {
    const canReuse = !force && lastConnected != null && now - lastAt < throttleMs;
    if (canReuse) return { probe: false, connected: !!lastConnected, throttled: true };
    return { probe: true, connected: null, throttled: false };
  }

  /** 连接布尔 → 徽章文案与底色。 */
  function badgeVisual(connected) {
    return connected
      ? { text: BADGE_TEXT_CONNECTED, color: BADGE_GREEN }
      : { text: BADGE_TEXT_DISCONNECTED, color: BADGE_RED };
  }

  const api = {
    BADGE_GREEN,
    BADGE_RED,
    BADGE_TEXT_CONNECTED,
    BADGE_TEXT_DISCONNECTED,
    BADGE_THROTTLE_MS,
    decideBadge,
    badgeVisual,
  };

  // service worker（经典脚本，background.js 经 importScripts 引入）：挂 self。
  if (typeof self !== "undefined" && self && !self.__careerOpsBadgePure) {
    self.__careerOpsBadgePure = api;
  }
  // node 单测：module.exports 守卫（同 wrapup-pure.js 口径）。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
