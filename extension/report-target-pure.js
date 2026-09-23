// report-target-pure.js — 报告跳转目标解析的纯逻辑层（ADR-0055）。
//
// 点击招聘站页面上的「已评估」徽章（列表卡片 / 详情页）与单职位评估完成后的自动
// 跳转，过去一律 chrome.tabs.create 新开标签页。改为优先复用「已经打开的 web 端」
// 后，真正需要判断的东西全在这里：
//   • parseWebTab       —— 一个标签页算不算本项目 web 端（origin + 端口区间粗判）；
//   • pickReportTarget  —— 候选池 → 目标标签页（端口优先 / 「最近活跃」近似规则 /
//                          同 URL 幂等 / 无候选兜底 / 端口探测失败的报错分支）；
//   • reportPath / reportUrl —— 报告页的客户端路由与整页 URL（家规：打开给用户看的
//                               页面一律用 localhost）。
//
// 之所以抽出来：多标签页优先级、同 URL 幂等、无候选兜底这些分支在真实浏览器里几乎
// 没法稳定复现，只有纯函数才测得起（同 badge-pure.js 的口径）。
//
// background.js 以经典 service worker 方式 importScripts 本文件，经
// self.__careerOpsReportTargetPure 取用；node 单测以 module.exports 守卫直接 import。
// 本文件严禁引用 chrome/window/document/location —— service worker 里没有 window，
// 加载即崩；chrome.webNavigation / URL 解析也只许用全局 URL 构造器。

(function () {
  "use strict";

  // web 端 origin 家规（modes/_custom.md）：localhost 与 127.0.0.1 两种写法都算，
  // 端口与 launcher 的 pickFreePort / background 的端口探测同区间。区间外的端口一律
  // 不算本项目 web 端 —— 这是粗判，不做身份握手（ADR-0055 决策 2 的显式取舍）。
  const WEB_PORT_MIN = 3000;
  const WEB_PORT_MAX = 3040;
  const WEB_HOSTS = ["localhost", "127.0.0.1"];
  // 端口探测失败时的用户可见文案：与 core.js 的兜底 toast 同文（维持今天的报错口径）。
  const NO_SERVICE_ERROR = "本地报告打不开：本地 web 服务可能未运行";

  /** 报告页在 web 端里的客户端路由（扩展→web 前端路由跳转用，ADR-0055 修订）。 */
  function reportPath(reportNum) {
    return `/report/${reportNum}`;
  }

  /** 报告页 URL（一律 localhost，家规）。 */
  function reportUrl(port, reportNum) {
    return `http://localhost:${port}${reportPath(reportNum)}`;
  }

  /**
   * URL 比较键：origin + 去尾斜杠的 pathname，忽略 query / hash。
   * 幂等判定（决策 6）只在「同一个报告页」这一粒度上成立，带不带跟踪参数不该
   * 触发一次整页重载。
   */
  function urlKey(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return "";
    }
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  }

  /**
   * 标签页 → web 端候选（不是候选返回 null）。
   * 口径：http 协议 + 主机 localhost/127.0.0.1 + 显式端口落在 3000-3040。
   * 不带端口（默认 80）、https、招聘站页、chrome:// 等一律不是候选。
   * @param {{id?:number, windowId?:number, active?:boolean, url?:string}} tab
   * @returns {?{id:number, windowId:(number|null), active:boolean, port:number, url:string, key:string}}
   */
  function parseWebTab(tab) {
    if (!tab || typeof tab.url !== "string") return null;
    let u;
    try {
      u = new URL(tab.url);
    } catch {
      return null;
    }
    if (u.protocol !== "http:") return null;
    if (!WEB_HOSTS.includes(u.hostname)) return null;
    const port = Number(u.port);
    if (!Number.isInteger(port) || port < WEB_PORT_MIN || port > WEB_PORT_MAX) return null;
    return {
      id: tab.id,
      windowId: typeof tab.windowId === "number" ? tab.windowId : null,
      active: !!tab.active,
      port,
      url: tab.url,
      key: urlKey(tab.url),
    };
  }

  /**
   * 解析一次 open-report 的跳转目标（ADR-0055 决策 3-6、8）。
   *
   * @param {object}   p
   * @param {?number}  p.livePort          ensureLivePort() 的结果（null = 端口探测失败）
   * @param {Array}    p.tabs              chrome.tabs.query({}) 的结果
   * @param {?number}  p.currentWindowId   「当前窗口」（最近聚焦窗口，退化用发起 tab 所在窗口）
   * @param {string|number} p.num          报告号
   * @returns {{action:"error", error:string}
   *          |{action:"create", url:string, path:string}
   *          |{action:"reuse", tabId:number, windowId:(number|null), url:string, path:string, navigate:boolean}}
   *   - error  ：端口探测失败 / 报告号非法 —— 不复用、也不新开（调用方报错即可）
   *   - create ：服务活着但没有任何 web 端标签页 —— 退回今天的行为新开一个
   *   - reuse  ：复用目标标签页；navigate=false 表示它已在同一报告 URL 上，只聚焦不重载；
   *              navigate=true 时调用方优先把它当「前端路由目标」（交给 web 端自己跳，
   *              不刷新页面），web 端没应声才回退用 url 整页导航
   */
  function pickReportTarget({ livePort, tabs, currentWindowId, num } = {}) {
    const reportNum = String(num == null ? "" : num).replace(/[^0-9]/g, "");
    if (!reportNum) return { action: "error", error: "无效报告号" };
    if (livePort == null) return { action: "error", error: NO_SERVICE_ERROR };

    const url = reportUrl(livePort, reportNum);
    const path = reportPath(reportNum);

    const candidates = (Array.isArray(tabs) ? tabs : []).map(parseWebTab).filter(Boolean);
    if (candidates.length === 0) return { action: "create", url, path };

    // 端口优先：先把报告交给「本次探测到的那个存活端口」上的 web 页，避免开进另一个实例。
    const livePortNum = Number(livePort);
    const samePort = candidates.filter((c) => c.port === livePortNum);
    const pool = samePort.length ? samePort : candidates;

    // 「最近活跃」的近似规则（决策 4）：当前窗口内的候选优先，其中 active 的最高；
    // 当前窗口没有候选才看全库，同样 active 优先。不依赖 tab.lastAccessed。
    const inWindow = currentWindowId == null ? [] : pool.filter((c) => c.windowId === currentWindowId);
    const scope = inWindow.length ? inWindow : pool;
    const tab = scope.find((c) => c.active) || scope[0];

    return {
      action: "reuse",
      tabId: tab.id,
      windowId: tab.windowId,
      url,
      path,
      navigate: tab.key !== urlKey(url),
    };
  }

  const api = {
    WEB_PORT_MIN,
    WEB_PORT_MAX,
    NO_SERVICE_ERROR,
    reportPath,
    reportUrl,
    urlKey,
    parseWebTab,
    pickReportTarget,
  };

  // service worker（经典脚本，background.js 经 importScripts 引入）：挂 self。
  if (typeof self !== "undefined" && self && !self.__careerOpsReportTargetPure) {
    self.__careerOpsReportTargetPure = api;
  }
  // node 单测：module.exports 守卫（同 badge-pure.js 口径）。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();