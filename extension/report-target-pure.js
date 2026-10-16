// report-target-pure.js — 报告跳转目标解析的纯逻辑层（ADR-0055）。
//
// 点击招聘站页面上的「已评估」徽章（列表卡片 / 详情页）与单职位评估完成后的自动
// 跳转，过去一律 chrome.tabs.create 新开标签页。改为优先复用「已经打开的 web 端」
// 后，真正需要判断的东西全在这里：
//   • parseWebTab       —— 一个标签页算不算本项目 web 端（origin + 端口区间粗判）；
//   • pickReportTarget  —— 候选池 → 目标标签页（端口优先 / 「最近活跃」近似规则 /
//                          同 URL 幂等 / 无候选兜底 / 端口探测失败的报错分支）；
//   • pickWebTarget     —— 浮窗面板级 🌐 的落点解析（ADR-0078）：同一套候选规则，
//                          落点是 /pipeline 收件箱，没有报告号参与；
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
  // 浮窗面板级 🌐 走 WEB_SERVICE_ERROR —— 那条链路上没有「报告」可打不开（ADR-0078）。
  const NO_SERVICE_ERROR = "本地报告打不开：本地 web 服务可能未运行";
  const WEB_SERVICE_ERROR = "Web 端打不开：本地 web 服务可能未运行";

  /** 报告页在 web 端里的客户端路由（扩展→web 前端路由跳转用，ADR-0055 修订）。 */
  function reportPath(reportNum) {
    return `/report/${reportNum}`;
  }

  /** 收件箱在 web 端里的客户端路由：面板级 🌐 的固定落点（ADR-0078）。 */
  function pipelinePath() {
    return "/pipeline";
  }

  /**
   * 体检报告在 web 端的落点（ADR-0074 接缝 D）。与评估报告不同：它没有前端路由
   * 页（台账里那份自包含 HTML 经 /api/checkup-report 只读提供），所以落点带 query。
   */
  function checkupPath(reportNum) {
    return `/api/checkup-report?n=${reportNum}`;
  }

  /** 报告页 URL（一律 localhost，家规）。 */
  function reportUrl(port, reportNum) {
    return `http://localhost:${port}${reportPath(reportNum)}`;
  }

  /** 收件箱 URL（同一条 localhost 家规，只是 path 不同）。 */
  function pipelineUrl(port) {
    return `http://localhost:${port}${pipelinePath()}`;
  }

  /** 体检报告 URL（同一条 localhost 家规，只是 path 不同）。 */
  function checkupUrl(port, reportNum) {
    return `http://localhost:${port}${checkupPath(reportNum)}`;
  }

  /**
   * URL 比较键：origin + 去尾斜杠的 pathname，缺省忽略 query / hash。
   * 幂等判定（决策 6）只在「同一个报告页」这一粒度上成立，带不带跟踪参数不该
   * 触发一次整页重载。
   *
   * @param {string} rawUrl
   * @param {boolean} [withQuery] 带 query 的落点（体检报告：同一个 pathname 下不同的 n）
   *   必须连 query 一起比，否则 n=99 的页面会被当成 n=12 的页面「已在原位」，
   *   只聚焦不导航 —— 用户点了半天看的还是上一家。评估报告的路由不带 query，依旧走缺省分支。
   */
  function urlKey(rawUrl, withQuery) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return "";
    }
    const path = u.pathname.replace(/\/+$/, "");
    return withQuery && u.search ? `${u.origin}${path}${u.search}` : `${u.origin}${path}`;
  }

  /**
   * 标签页 → web 端候选（不是候选返回 null）。
   * 口径：http 协议 + 主机 localhost/127.0.0.1 + 显式端口落在 3000-3040。
   * 不带端口（默认 80）、https、招聘站页、chrome:// 等一律不是候选。
   * @param {{id?:number, windowId?:number, active?:boolean, url?:string}} tab
   * @returns {?{id:number, windowId:(number|null), active:boolean, port:number, url:string, key:string, keyWithQuery:string}}
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
      // 两个粒度各算一份：评估报告比 key（忽略跟踪参数），带 query 的体检落点比
      // keyWithQuery（不然同 pathname 的不同报告会互相认成同一个页）。
      keyWithQuery: urlKey(tab.url, true),
    };
  }

  /**
   * 候选池 → 目标标签页，pickReportTarget / pickWebTarget 共用（ADR-0055 / ADR-0078）：
   * 端口优先 → 当前窗口内 active 优先 → 全库 active 优先 → 全库首个。没有候选返回 null。
   */
  function pickWebTab({ livePort, tabs, currentWindowId } = {}) {
    const candidates = (Array.isArray(tabs) ? tabs : []).map(parseWebTab).filter(Boolean);
    if (candidates.length === 0) return null;
    // 端口优先：先把跳转交给「本次探测到的那个存活端口」上的 web 页，避免开进另一个实例。
    const livePortNum = Number(livePort);
    const samePort = candidates.filter((c) => c.port === livePortNum);
    const pool = samePort.length ? samePort : candidates;
    // 「最近活跃」的近似规则（决策 4）：当前窗口内的候选优先，其中 active 的最高；
    // 当前窗口没有候选才看全库，同样 active 优先。不依赖 tab.lastAccessed。
    const inWindow = currentWindowId == null ? [] : pool.filter((c) => c.windowId === currentWindowId);
    const scope = inWindow.length ? inWindow : pool;
    return scope.find((c) => c.active) || scope[0];
  }

  /**
   * 解析一次 open-report 的跳转目标（ADR-0055 决策 3-6、8）。
   *
   * @param {object}   p
   * @param {?number}  p.livePort          ensureLivePort() 的结果（null = 端口探测失败）
   * @param {Array}    p.tabs              chrome.tabs.query({}) 的结果
   * @param {?number}  p.currentWindowId   「当前窗口」（最近聚焦窗口，退化用发起 tab 所在窗口）
   * @param {string|number} p.num          报告号（对体检而言就是 tracker#）
   * @param {string}   [p.kind]            "report"（缺省）| "checkup" —— 只换落点，
   *   候选筛选 / 端口优先 / 幂等规则两条出口共用
   * @returns {{action:"error", error:string}
   *          |{action:"create", url:string, path:string}
   *          |{action:"reuse", tabId:number, windowId:(number|null), url:string, path:string, navigate:boolean}}
   *   - error  ：端口探测失败 / 报告号非法 —— 不复用、也不新开（调用方报错即可）
   *   - create ：服务活着但没有任何 web 端标签页 —— 退回今天的行为新开一个
   *   - reuse  ：复用目标标签页；navigate=false 表示它已在同一报告 URL 上，只聚焦不重载；
   *              navigate=true 时调用方优先把它当「前端路由目标」（交给 web 端自己跳，
   *              不刷新页面），web 端没应声才回退用 url 整页导航
   */
  function pickReportTarget({ livePort, tabs, currentWindowId, num, kind } = {}) {
    const reportNum = String(num == null ? "" : num).replace(/[^0-9]/g, "");
    if (!reportNum) return { action: "error", error: "无效报告号" };
    if (livePort == null) return { action: "error", error: NO_SERVICE_ERROR };

    const isCheckup = kind === "checkup";
    // 带 query 的落点（体检）把 query 也纳入幂等比较；不带的（评估报告）行为逐字不变。
    const withQuery = isCheckup;
    const url = isCheckup ? checkupUrl(livePort, reportNum) : reportUrl(livePort, reportNum);
    const path = isCheckup ? checkupPath(reportNum) : reportPath(reportNum);

    const tab = pickWebTab({ livePort, tabs, currentWindowId });
    if (!tab) return { action: "create", url, path };

    return {
      action: "reuse",
      tabId: tab.id,
      windowId: tab.windowId,
      url,
      path,
      navigate: (withQuery ? tab.keyWithQuery : tab.key) !== urlKey(url, withQuery),
    };
  }

  /**
   * 解析一次 open-web 的跳转目标：浮窗标题栏 🌐 的面板级落点（ADR-0078）。
   *
   * 与 pickReportTarget 同一套候选规则（pickWebTab），但落点是 /pipeline 收件箱、
   * 没有报告号参与——所以不塞进 pickReportTarget 的 kind 参数，独立成函数：
   * 那边的 num 校验与 report/checkup 双落点分支是既有单测的契约，不为第三落点改签名。
   *
   * @param {object}  [p]
   * @param {?number} p.livePort          ensureLivePort() 的结果（null = 端口探测失败）
   * @param {Array}   p.tabs              chrome.tabs.query({}) 的结果
   * @param {?number} p.currentWindowId   「当前窗口」（同 pickReportTarget 口径）
   * @returns {{action:"error", error:string}
   *          |{action:"create", url:string, path:string}
   *          |{action:"reuse", tabId:number, windowId:(number|null), url:string, path:string, navigate:boolean}}
   *   出口语义与 pickReportTarget 一致；幂等粒度 = origin+pathname（/pipeline 无 query）。
   */
  function pickWebTarget({ livePort, tabs, currentWindowId } = {}) {
    if (livePort == null) return { action: "error", error: WEB_SERVICE_ERROR };
    const url = pipelineUrl(livePort);
    const path = pipelinePath();
    const tab = pickWebTab({ livePort, tabs, currentWindowId });
    if (!tab) return { action: "create", url, path };
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
    WEB_SERVICE_ERROR,
    reportPath,
    reportUrl,
    pipelinePath,
    pipelineUrl,
    checkupPath,
    checkupUrl,
    urlKey,
    parseWebTab,
    pickReportTarget,
    pickWebTarget,
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