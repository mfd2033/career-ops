// BOSS直聘 就地评估 — background service worker (the hub).
//
// Owns everything that needs a fetch to the local web dashboard, because the
// content script runs in zhipin.com's origin and its cross-origin fetches would
// be refused by the backend's origin-guard. Everything here goes through the
// extension's own chrome-extension://{id} origin, which the backend explicitly
// trusts on loopback (web/src/lib/extension-origin.mjs) and the extension's
// host_permissions let it read without CORS.
//
// Responsibilities:
//   • probe localhost:3000-3040 /api/version → web port (cache, re-probe)
//   • resolve cliId/model from the web config page's saved pick (/api/config)
//   • load + refresh the "evaluated" map (/api/report-status)
//   • run batch evaluation (/api/batch-evaluate) and stream NDJSON to the popup
//   • open the web report page for an evaluated position

// ---- port probing ---------------------------------------------------------

const PORT_MIN = 3000;
const PORT_MAX = 3040;
// Chromium 对 127.0.0.1 等私有地址的首次连接有 ~0.6-1.2s 预热延迟（PNA/IP 决策，
// 不发 OPTIONS，同一浏览器进程内仅首次生效）。900ms 超时会恰好截断冷启动探测，
// 导致"服务未运行"误报，故放宽到 3s。
const PROBE_TIMEOUT_MS = 3000;

let cachedPort = null;
let probing = null;

// Latest DOM diagnostics reported by the content script (for the popup's
// debug box, since BOSS blocks DevTools by resizing/kicking the page).
let lastContentDiag = null;

// 最近一次版本探测失败的根因：http 状态下标为 `http:{status}`，网络/CORS 错误标记为 `net:{msg}`，CORS 拦截常表现为 TypeError。
let lastProbeErr = null;

async function versionOk(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/version`, { signal: ctrl.signal });
    if (!res.ok) {
      lastProbeErr = `http:${res.status}`;
      return false;
    }
    const j = await res.json();
    lastProbeErr = null;
    return !!(j && j.version);
  } catch (e) {
    // CORS 拦截、host_permissions 缺失、拒绝连接等都会走到这里
    lastProbeErr = `net:${(e && e.message) || e}`;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Sweep 3000-3040 once, return first live port (or null). */
function sweepPorts() {
  const attempts = [];
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    attempts.push(versionOk(`http://127.0.0.1:${port}`).then((ok) => (ok ? port : null)));
  }
  return Promise.all(attempts).then((found) => found.find((p) => p != null) ?? null);
}

/**
 * First live port in 3000-3040 (all probed concurrently, first ok wins).
 * 冷启动时 Chromium 对私有地址首次连接有预热延迟，第一轮可能整体超时；
 * 等预热完成再重扫一轮，避免把"刚启动的 web 服务"误判为未运行。
 */
function probePort() {
  if (cachedPort) return Promise.resolve(cachedPort);
  if (probing) return probing;
  probing = sweepPorts().then(async (port) => {
    if (port == null) {
      await new Promise((r) => setTimeout(r, 250));
      port = await sweepPorts();
    }
    probing = null;
    cachedPort = port;
    return cachedPort;
  });
  return probing;
}

/** Drop the cached port so the next request re-probes (web restarted elsewhere). */
function invalidatePort() {
  cachedPort = null;
}

async function needPort() {
  const port = await probePort();
  if (port == null) throw new Error("本地 web 服务未运行（扫描 127.0.0.1:3000-3040 未命中）");
  return port;
}

/**
 * Port guaranteed live right now: verify the cached port first (it may have
 * gone away since it was probed), else re-probe. Prevents clicking an evaluated
 * badge from opening a dead localhost link when the dashboard restarted.
 */
async function ensureLivePort() {
  console.log("[bg] ensureLivePort cachedPort=", cachedPort);
  if (cachedPort && (await versionOk(`http://127.0.0.1:${cachedPort}`))) {
    console.log("[bg] cached port live:", cachedPort);
    return cachedPort;
  }
  invalidatePort();
  const p = await needPort();
  console.log("[bg] re-probed port:", p);
  return p;
}

// ---- toolbar connection-status badge (ADR-0050) ---------------------------
//
// 把「本地 web 服务是否在线」外显到工具栏图标，不用点开 popup。连接状态是全局
// 属性，故 setBadge* 不带 tabId（全局常显）。二值：连上=绿✓、未连=红!（版本校验
// 失败按未连处理，无第三态；probing 不单独显示）。节流与视觉映射的纯逻辑抽到
// badge-pure.js（可单测），此处只做 chrome 接线。
importScripts("badge-pure.js");
const BADGE = self.__careerOpsBadgePure;
if (!BADGE) throw new Error("[bg] badge-pure.js 未加载:扩展文件不完整");

let lastBadgeAt = 0;
let lastBadgeConnected = null; // null=尚未确定（首次必探）

/**
 * 依当前连接状态重绘徽章。force=true 绕过 5s 节流（reprobe / 批量结束等明确信号）。
 * 节流命中时复用上次结果，不重新扫 3000-3040。
 */
async function updateBadge(force) {
  const d = BADGE.decideBadge({
    now: Date.now(),
    lastAt: lastBadgeAt,
    lastConnected: lastBadgeConnected,
    force: !!force,
  });
  if (!d.probe) {
    await paintBadge(d.connected);
    return;
  }
  lastBadgeAt = Date.now();
  const port = await ensureLivePort().catch(() => null);
  lastBadgeConnected = port != null;
  await paintBadge(lastBadgeConnected);
}

/** 落徽章（不含探测，供 updateBadge / get-state 复用）。 */
async function paintBadge(connected) {
  const v = BADGE.badgeVisual(connected);
  try {
    await chrome.action.setBadgeBackgroundColor({ color: v.color });
    await chrome.action.setBadgeText({ text: v.text });
  } catch {
    /* 无 action API / 极端环境：忽略，下次事件再刷 */
  }
}

// 冷启动即点亮：安装/更新、浏览器启动各探一次（不依赖用户先开 popup）。
chrome.runtime.onInstalled.addListener(() => {
  updateBadge(true).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  updateBadge(true).catch(() => {});
});
// 浏览中保持实时：切标签页、页面加载完成各刷一次（5s 节流兜底防端口扫描风暴）。
chrome.tabs.onActivated.addListener(() => {
  updateBadge().catch(() => {});
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo && changeInfo.status === "complete") updateBadge().catch(() => {});
});

// ---- cliId / model resolution ---------------------------------------------

/** Reuse the CLI + model picked on the web config page; fall back to sole installed. */
async function resolveEvalConfig(base) {
  let cliId = null;
  let model = null;
  let unknownEmployer = null;
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    if (cfg && typeof cfg.cliId === "string" && cfg.cliId) cliId = cfg.cliId;
    if (cfg && typeof cfg.model === "string" && cfg.model) model = cfg.model;
    if (cfg && cfg.unknownEmployer === "agency") unknownEmployer = "agency";
  } catch {
    /* server config missing — fall back below */
  }
  if (!cliId) {
    try {
      const d = await (await fetch(`${base}/api/clis`)).json();
      const installed = (d && d.clis ? d.clis : []).filter((c) => c.installed);
      // No single installed CLI to fall back to → pick a sensible default (the
      // career-ops flagship CLI first, else the first installed) instead of
      // leaving cliId empty and failing downstream with "CLI '' not found".
      if (installed.length === 1) cliId = installed[0].id;
      else {
        const preferred = installed.find((c) => c.id === "opencode") || installed[0];
        if (preferred) cliId = preferred.id;
      }
    } catch {
      /* no CLIs readable */
    }
  }
  return { cliId, model, unknownEmployer };
}

// ---- evaluated map --------------------------------------------------------

// normalizedUrl → { score, reportNum }; refreshed from /api/report-status.
let evaluated = {};

// ---- quick-eval scores ----------------------------------------------------

// normalizedUrl → { score, grade, reason }; persisted in chrome.storage.local so
// the quick score survives page navigation/reload (the detail page must still
// show it after a list-page quick eval). Independent of `evaluated` (full report).
let quickScores = {};

function quickKey(url) {
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url.trim());
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

chrome.storage.local.get(["quickScores"], (r) => {
  quickScores = r && r.quickScores && typeof r.quickScores === "object" ? r.quickScores : {};
});

/** Tell every supported-board tab (zhipin/liepin/zhaopin) to refresh quick-score + re-render. */
async function notifyQuickUpdated() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    if (tab.url && /^https?:\/\/([^/]*\.)?(zhipin|liepin|zhaopin)\.com\//.test(tab.url)) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "quick-updated" });
      } catch {
        /* tab closed or content not injected — ignore */
      }
    }
  }
}

async function loadEvaluated(base) {
  try {
    const res = await fetch(`${base}/api/report-status`);
    console.log("[bg] loadEvaluated", base, "status=", res.status);
    const j = await res.json();
    evaluated = j && typeof j === "object" ? j : {};
    console.log("[bg] report-status keys=", Object.keys(evaluated).length);
    return evaluated;
  } catch (err) {
    console.log("[bg] loadEvaluated error:", err.message);
    evaluated = {};
  }
  return evaluated;
}

// ---- extension-driven explore scan (ADR-0007 E2/E5) -----------------------

// 探索页浏览器采集驱动从 Playwright 换到扩展:background 收「驱动扫描」后查既存
// 三站 tab,命中向该 tab content script 发 start-scan;无则 chrome.tabs.create 开
// 对应搜索 URL 再驱动。复用用户真实登录态,不新开独立 profile(E2)。
//
// 三站列表/详情 pathname 判定(与 site-*.js isDetailPath 保持一致,仅用于选既存
// tab 时尽量避开详情页;content 侧 start-scan 仍会再拦,双保险)。
// 扫描收尾判定(ADR-0007 E9)的纯逻辑层。manifest 未声明 "type":"module",本 SW 是
// 经典脚本,故用 importScripts —— 必须顶层同步调用(SW 起不来就全废)。
importScripts("wrapup-pure.js");
// 同包加载,理论上不会缺;缺了说明扩展文件不完整 —— 在加载期就炸出来,而不是让每条
// scan-done 静默失效。(与 core.js 对 SCAN 缺失的容忍口径不同:那里 content script 与
// SW 的版本会在"扩展重载"窗口期真实错配,这里两个文件同属一个 SW,不会。)
const WRAPUP = self.__careerWrapupPure;
if (!WRAPUP) throw new Error("[bg] wrapup-pure.js 未加载:扩展文件不完整");

const DRIVE_SOURCES = {
  zhipin: {
    hostRe: /^https?:\/\/([^/]*\.)?zhipin\.com\//i,
    isDetail: (p) => p.includes("/job_detail/"),
  },
  liepin: {
    hostRe: /^https?:\/\/([^/]*\.)?liepin\.com\//i,
    isDetail: (p) => /^\/(job|a)\/\d+\.shtml$/i.test(p),
  },
  zhaopin: {
    hostRe: /^https?:\/\/([^/]*\.)?zhaopin\.com\//i,
    isDetail: (p) => /^\/jobdetail\/[^/?#]+\.htm$/i.test(p),
  },
};

// {source, url} → { scanId, tabId };同一 source+url 已有活跃驱动时,重复 drive-scan
// 直接回报 "active" 且不新开 tab(防连点/重放产生重复采集 tab)。key 为
// `${source}|${url}`:拆词扫描时猎聘同 source 多条不同关键词 URL 需独立 tab 各自
// 采集,不能按 source 去重 —— 否则第二条词会被 activeDrives 吞掉(采不全)。
const activeDrives = new Map();
const driveKey = (source, url) => `${source}|${url}`;

// scanId → DiscoveredOffer[];content script 分批上报的增量本地缓冲,供探索页在采集
// 收尾后一次取回用于结果渲染(ADR-0021:上报只记「见过」台账,结果区是这些候选的
// 展示面;入管由用户在结果区勾选后显式确认)。
const scanOffers = new Map();

// ---- 扫描收尾(ADR-0007 E9) ------------------------------------------------

// 发起本次扫描的探索页 tab(由 localhost 桥的 sender.tab 给出)与收尾开关,随
// drive-scan 一起进来。同一时刻只有一次探索页驱动的扫描(前端 runningRef 拦连点),
// 故用单份模块状态而非按 scanId 存表。
let exploreTabId = null;
let wrapUpEnabled = true;

// 已收尾过的 scanId:幂等,挡掉迟到的 scan-done 与事件竞态下的重复收尾。有条数上限 ——
// SW 常驻期内扫描次数无上限,不设界就是慢性泄漏。
const wrappedUpScans = new Set();
const WRAPPED_SCANS_MAX = 20;

/** 只切 active tab,**不动窗口焦点**:浏览器在后台时不该被拽到前台(E9)。 */
function activateExploreTab(tabId) {
  try {
    const p = chrome.tabs.update(tabId, { active: true });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {
    console.log("[bg] wrap-up activate failed:", (e && e.message) || e);
  }
}

/** 向采集 tab 发停止采集(content 侧 stop-scan 处理器已存在,收尾会把剩余批次上报)。 */
function stopDriveTab(tabId) {
  try {
    const p = chrome.tabs.sendMessage(tabId, { type: "stop-scan" });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {
    /* tab 已关 / content 未注入 —— 无需处理 */
  }
}

/** 收尾判定要的登记快照。判定自行按 scanId 归口(见 wrapup-pure 的 decideWrapUp)。 */
function driveSnapshots() {
  return [...activeDrives].map(([key, entry]) => ({ key, scanId: entry.scanId }));
}

/**
 * 摘掉某个 tab 在登记表里的全部登记 —— 「采集结束(scan-done)」与「采集 tab 被关」两条
 * 路径共用。tabId 优先,URL 后缀兜底(sender.tab 缺失时的老认领方式)。key 形状是
 * `${source}|${url}`,故必须按 key 精确摘,不能按 source 一把清(猎聘拆词时同 source
 * 有多条 URL 各自独立登记)。
 * @returns {string|null} 被摘掉的登记所属的 scanId;无匹配时 null(登记必然带 scanId,
 *   故 null 恒等于"没摘到东西")。
 */
function endDrivesForTab(tabId, url) {
  const keys = [];
  for (const [key, entry] of activeDrives) {
    if ((tabId != null && entry.tabId === tabId) || (url && key.endsWith(`|${url}`))) keys.push(key);
  }
  let endedScanId = null;
  for (const key of keys) {
    const entry = activeDrives.get(key);
    if (entry && entry.scanId) endedScanId = entry.scanId;
    activeDrives.delete(key);
  }
  return endedScanId;
}

/** 收尾判定 → 动作。settle 为真则记 scanId(幂等);有 activateTabId 才切焦点。 */
function runWrapUp(facts) {
  const decision = WRAPUP.decideWrapUp({ ...facts, wrappedUpScans: [...wrappedUpScans] });
  if (decision.settle) {
    wrappedUpScans.add(decision.scanId);
    while (wrappedUpScans.size > WRAPPED_SCANS_MAX) {
      // Set 保持插入序,淘汰最老的:SW 常驻期内扫描次数无上限,不设界就是慢性泄漏。
      wrappedUpScans.delete(wrappedUpScans.values().next().value);
    }
  }
  console.log(
    "[bg] scan wrap-up:",
    decision.reason,
    decision.activateTabId == null ? "(no tab switch)" : `→ tab ${decision.activateTabId}`,
  );
  if (decision.activateTabId != null) activateExploreTab(decision.activateTabId);
  return decision;
}

/** 问一句采集 tab:内容脚本按自己的状态答。无应答(tab 已关 / content 没注入 / 被换页)
 *  一律当死 —— fail-closed,理由见 wrapup-pure 的 decideDeadDrives(漏判会让收尾永不触发)。 */
async function pingDriveTab(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "scan-ping" });
    return !!(r && r.active);
  } catch (e) {
    return false;
  }
}

/**
 * 采集端存活探测(ADR-0007 E10):反爬把采集 tab 整页跳到验证页 / 换域名时,content
 * script 连同它的定时器一起被销毁,`scan-done` 永远发不出来 —— 登记一直留着,收尾也
 * 永不触发,用户就停在验证页上。这里借前端 2s 一次的 scan-status 轮询顺手问一句:内容
 * script 按自己的状态回答,答不出或答"不在采集"就按该驱动结束处理(摘登记 + 走收尾)。
 * 只探已完成启动握手的登记 —— tab 刚开、content 还没注入时的无应答是正常的。
 */
async function probeDeadDrives() {
  const drives = [...activeDrives].map(([key, entry]) => ({
    key,
    scanId: entry.scanId,
    started: !!entry.started,
    tabId: entry.tabId,
  }));
  const probes = [];
  for (const d of drives) {
    if (!d.started) continue;
    probes.push({ key: d.key, alive: await pingDriveTab(d.tabId) });
  }
  const { deadKeys, scanId } = WRAPUP.decideDeadDrives({ drives, probes });
  if (deadKeys.length === 0) return;
  for (const key of deadKeys) activeDrives.delete(key);
  console.log("[bg] drive went silent → ended", deadKeys.length, "drive(s)");
  if (scanId) {
    runWrapUp({ drives: driveSnapshots(), scanId, wrapUpEnabled, exploreTabId });
  }
}

/**
 * tab 关闭的两条路径(E9):
 *   ① 探索页被关 → 结果再也无处展示(结果只活在原 tab 的 state 与 per-tab
 *      sessionStorage 里),停掉所有仍在跑的采集 —— 本动作**不受收尾开关管辖**,省的是
 *      浪费而非「回到页面」。已采到的由内容脚本收尾时照常上报落库,不丢数据。
 *   ② 采集 tab 被关 → 摘掉它的登记。残留登记会让 scan-status 永远报该平台 active
 *      (探索页进度轮询固定空转到 180s 兜底才退出),并让下一次相同条件的扫描被
 *      driveSource 判为「已在驱动中」而静默不打开任何 tab。
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (exploreTabId != null && tabId === exploreTabId) {
    const drives = [...activeDrives].map(([key, entry]) => ({ key, tabId: entry.tabId }));
    const abort = WRAPUP.decideAfterExploreGone({ drives });
    for (const key of abort.clearKeys) activeDrives.delete(key);
    for (const id of abort.stopTabIds) stopDriveTab(id);
    exploreTabId = null; // 之后迟到的 scan-done 只会 settle,不再切焦点
    console.log("[bg] explore tab closed → stopped", abort.stopTabIds.length, "drive(s)");
    return;
  }
  const endedScanId = endDrivesForTab(tabId, null);
  if (endedScanId) {
    runWrapUp({ drives: driveSnapshots(), scanId: endedScanId, wrapUpEnabled, exploreTabId });
  }
});

/** 向某 tab 的 content script 发 start-scan(tab 未注入/已关闭时返回 {ok:false})。
 *  maxCount:该站采集条数上限(来自 web 配置),透传给累积器覆盖硬编码 SCAN_MAX。 */
async function tryStartScan(tabId, scanId, maxCount) {
  try {
    const msg = { type: "start-scan", scanId };
    if (typeof maxCount === "number" && maxCount > 0) msg.maxCount = maxCount;
    return (await chrome.tabs.sendMessage(tabId, msg)) || { ok: false };
  } catch {
    return { ok: false, error: "no-receiver" };
  }
}

/** 等 tab 加载到 status complete,或超时放行(SPA 注入可能晚于 complete,放行后再试)。 */
function waitTabLoaded(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** 新开搜索 tab、等加载完成、驱动扫描;content 未及时就绪时多等 800ms 重试一轮。 */
async function openAndDrive(source, url, scanId, maxCount) {
  try {
    const key = driveKey(source, url);
    const tab = await chrome.tabs.create({ url });
    activeDrives.set(key, { scanId, tabId: tab.id, started: false });
    await waitTabLoaded(tab.id);
    let res = await tryStartScan(tab.id, scanId, maxCount);
    if (!res || !res.ok) {
      await new Promise((r) => setTimeout(r, 800));
      res = await tryStartScan(tab.id, scanId, maxCount);
    }
    if (res && res.ok) {
      // 握上手才算"这个采集端应该活着":在此之前无应答是正常的,存活探测必须让开这段窗口。
      const entry = activeDrives.get(key);
      if (entry) entry.started = true;
      return { source, status: "created", tabId: tab.id, scanId: res.scanId || scanId };
    }
    activeDrives.delete(key); // 启动失败:清登记,允许后续重试驱动
    return { source, status: "failed", tabId: tab.id, error: (res && res.error) || "content not ready" };
  } catch (e) {
    return { source, status: "failed", error: (e && e.message) || String(e) };
  }
}

/**
 * 驱动单个平台:查既存 hosts 命中 tab,优先取列表页驱动;都不可用/被拒则新开搜索
 * tab。activeDrives 按 {source,url} 登记成功来源,scan-done 时清除,避免重复驱动。
 */
async function driveSource(source, url, scanId, maxCount) {
  const spec = DRIVE_SOURCES[source];
  const key = driveKey(source, url);
  const active = activeDrives.get(key);
  if (active) return { source, status: "active", tabId: active.tabId, scanId: active.scanId };
  if (!spec) return { source, status: "failed", error: "unknown source" };
  return openAndDrive(source, url, scanId, maxCount);
}

/**
 * 收「驱动扫描」:遍历请求的平台,查/开 tab 并驱动。scanId 缺省时生成一次会话 id
 * 并随结果返回(web 侧后续重放同 id 走路由幂等)。返回每平台 task 状态。
 */
async function driveScan(msg, sender) {
  const scanId = typeof msg.scanId === "string" && msg.scanId.trim() ? msg.scanId.trim() : `ext-scan-${Date.now()}`;
  const requested = Array.isArray(msg.sources)
    ? msg.sources
        .map((s) => (s && typeof s.source === "string" ? s : { source: s }))
        .filter((s) => s && typeof s.source === "string" && DRIVE_SOURCES[s.source] && typeof s.url === "string" && /^https?:\/\//i.test(s.url))
        .map((s) => ({ source: s.source, url: s.url, maxCount: typeof s.maxCount === "number" && s.maxCount > 0 ? s.maxCount : undefined }))
    : [];
  // 收尾上下文:web-bridge 是注入在本地面板上的 content script,故 sender.tab 就是发起
  // 本次扫描的探索页 tab —— 不用猜端口,也不用从页面 URL 反推。wrapUp 缺省按开启处理,
  // 老版本前端(不带该字段)仍工作。
  exploreTabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;
  wrapUpEnabled = msg.wrapUp !== false;
  if (requested.length === 0) return { ok: true, scanId, connected: true, tasks: [] };
  const tasks = [];
  for (const s of requested) {
    // 顺序驱动(每平台一次采集会话,避免同时弹多个搜索 tab)。每步失败不中断其它平台。
    tasks.push(await driveSource(s.source, s.url, scanId, s.maxCount));
  }
  // 全部平台一个都没起来:openAndDrive 是先开 tab 再握手,失败时 tab 留着(只摘登记),
  // 用户已经被带到那个空 tab 上 —— 立即收尾把他送回探索页(E9)。部分失败不在此列,
  // 仍等成功启动的平台跑完(它们各自的 scan-done 会触发收尾)。
  if (!tasks.some((t) => t && (t.status === "created" || t.status === "active"))) {
    runWrapUp({ drives: driveSnapshots(), scanId, wrapUpEnabled, exploreTabId });
  }
  return { ok: true, scanId, connected: true, tasks };
}

/**
 * content script 分批上报 → SW 转发 web /api/explore/seen(ADR-0021,改自 E5 的
 * /api/explore/add)。采集只记「见过」台账(scan-history.tsv),不写 pipeline.md ——
 * 「扫描 ≠ 加入管道」,入管由用户在探索页结果区勾选后经 /api/explore/add 显式确认。
 * 批量上报本身即活动事件,间隔常醒来 SW,无需额外 keepalive。环回同源走
 * host_permissions,CORS 豁免。
 */
async function relayScanBatch(scanId, offers) {
  const base = `http://127.0.0.1:${await ensureLivePort()}`;
  const res = await fetch(`${base}/api/explore/seen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scanId, offers }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) console.log(`[bg] scan-batch relay ${res.status}:`, j && j.error);
  return j;
}

// ---- message routing ------------------------------------------------------

const selectionByTab = new Map(); // tabId → string[] (selected posting URLs)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "get-state": {
        if (msg && msg.force) invalidatePort();
        const port = await ensureLivePort().catch(() => null);
        sendResponse({ ok: true, connected: port != null, port });
        // 徽章与 popup 读同一状态：复用刚探到的 port 立即重绘（不重复扫描），
        // 并同步节流缓存。force（手动 reprobe）因上方已 invalidatePort 会重扫真值。
        lastBadgeAt = Date.now();
        lastBadgeConnected = port != null;
        await paintBadge(port != null);
        break;
      }
      case "get-evaluated": {
        const port = await ensureLivePort().catch(() => null);
        if (port == null) {
          sendResponse({ ok: false, connected: false, map: {} });
          break;
        }
        const map = await loadEvaluated(`http://127.0.0.1:${port}`);
        sendResponse({ ok: true, connected: true, port, map, keys: Object.keys(map).length });
        break;
      }
      case "get-quick": {
        sendResponse({ ok: true, map: quickScores, keys: Object.keys(quickScores).length });
        break;
      }
      case "get-diagnostics": {
        const port = await ensureLivePort().catch(() => null);
        sendResponse({
          ok: true,
          connected: port != null,
          port,
          cachedPort,
          extensionId: (chrome.runtime && chrome.runtime.id) || null,
          versionErr: lastProbeErr,
          evalKeys: Object.keys(evaluated).length,
          contentDiag: lastContentDiag,
        });
        break;
      }
      case "diag-report": {
        lastContentDiag = msg && msg.data ? msg.data : null;
        sendResponse({ ok: true });
        break;
      }
      case "selection-update": {
        const tabId = sender.tab ? sender.tab.id : null;
        const urls = Array.isArray(msg.urls) ? msg.urls.filter((u) => typeof u === "string") : [];
        if (tabId != null) {
          if (urls.length) selectionByTab.set(tabId, urls);
          else selectionByTab.delete(tabId);
        }
        sendResponse({ ok: true });
        break;
      }
      case "get-selection": {
        const urls = selectionByTab.get(msg.tabId) || [];
        sendResponse({ ok: true, urls });
        break;
      }
      case "open-report": {
        try {
          const port = await ensureLivePort();
          const num = String(msg.num || "").replace(/[^0-9]/g, "");
          if (!num) {
            sendResponse({ ok: false, error: "无效报告号" });
            break;
          }
          await chrome.tabs.create({ url: `http://127.0.0.1:${port}/report/${num}` });
          sendResponse({ ok: true, reportUrl: `http://127.0.0.1:${port}/report/${num}` });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case "refresh-evaluated": {
        try {
          const port = await ensureLivePort();
          await loadEvaluated(`http://127.0.0.1:${port}`);
          await notifyContentScripts();
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case "single-evaluate": {
        // Detail-page single evaluation (ADR-0051): one job goes through the
        // single-task channel — POST /api/run + the /api/events bus — so it lands
        // in /jobs as an `evaluate` card with its own step timeline and report jump,
        // exactly like a URL pasted into the web UI. A server too old to accept the
        // inline JD on /api/run is detected once per dispatch (capability flag) and
        // falls back to the batch endpoint, which is what this button always did.
        // Progress still streams to any attached popup eval port; on completion the
        // map refreshes and content scripts re-render badges (the detail button
        // reads it via evaluated-updated, with its 3s poll as the safety net).
        const url = typeof msg.url === "string" ? msg.url.trim() : "";
        if (!/^https?:\/\//i.test(url)) {
          sendResponse({ ok: false, error: "无效职位 URL" });
          break;
        }
        sendResponse({ ok: true });
        const tabId = sender.tab ? sender.tab.id : null;
        // 内联 JD/雇主名(详情页 DOM 提取,猎聘等登录墙站点绕开服务端抓取)。
        const jdText = typeof msg.jdText === "string" && msg.jdText.trim() ? msg.jdText.trim() : "";
        const company = typeof msg.company === "string" && msg.company.trim() ? msg.company.trim() : "";
        (async () => {
          const base = `http://127.0.0.1:${await ensureLivePort()}`;
          const cfg = await resolveEvalConfig(base);
          const cliId = msg.cliId || cfg.cliId;
          const model = msg.model || cfg.model || null;
          if ((await probeEvalRoute(base)) === "run") {
            await runSingleViaApi({ base, url, cliId, model, jdText, company, tabId });
            return;
          }
          // 回落路径逐字保留：老 exe / 老 dev 服务上这个按钮的行为与 ADR-0051 之前一致。
          try {
            await runBatch([url], cliId, model, { jdText, company });
          } catch (err) {
            announce({ stage: "error", error: err.message });
            // The action popup auto-closes when the user clicks the page button, so
            // `announce`'s eval port is usually gone. Route the failure back to the
            // detail tab instead so the page can toast it and reset the button.
            if (tabId != null) {
              try {
                await chrome.tabs.sendMessage(tabId, { type: "single-eval-error", error: err.message });
              } catch {
                /* tab closed or content not injected — ignore */
              }
            }
          }
        })().catch((err) => {
          // Nothing else catches this promise: a dead local server must not fail
          // silently and leave the button stuck on "评估中".
          announce({ stage: "error", error: err instanceof Error ? err.message : String(err) });
          if (tabId != null) {
            chrome.tabs.sendMessage(tabId, { type: "single-eval-error", error: err instanceof Error ? err.message : String(err) }).catch(() => {});
          }
        });
        break;
      }
      case "quick-evaluate": {
        // 快评：直连本地 /api/quick-eval（DOM 已提取 JD 文本，无需服务端抓取）。
        // 独立于 single-evaluate；失败只回传给详情页 toast，不越权改跑完整评估。
        const tabId = sender.tab ? sender.tab.id : null;
        const sendTab = (ev) => {
          if (tabId == null) {
            announce(ev);
            return;
          }
          chrome.tabs.sendMessage(tabId, ev).catch(() => {});
        };
        try {
          const port = await ensureLivePort();
          const base = `http://127.0.0.1:${port}`;
          // 快评跟随未知雇主策略：「显示代招名」时，把发帖公司名前缀进 JD 文本，
          // 使快评与完整评估口径一致（代招/"?" 不两张皮）。未配置策略 → 不前缀。
          let text = typeof msg.text === "string" ? msg.text : "";
          const poster = typeof msg.poster === "string" ? msg.poster.trim() : "";
          const cfg = await resolveEvalConfig(base);
          if (cfg.unknownEmployer === "agency" && poster) {
            text = `发布方公司：${poster}\n${text}`;
          }
          const res = await fetch(`${base}/api/quick-eval`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: typeof msg.url === "string" ? msg.url : "",
              title: typeof msg.title === "string" ? msg.title : "",
              text,
            }),
            signal: AbortSignal.timeout(8000),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) {
            const notice =
              j && j.error === "quickEvalNotConfigured"
                ? "快评不可用：未配置 AI 密钥（设置页 → 粘贴 AI 密钥）"
                : "快评失败：" + ((j && j.error) || `HTTP ${res.status}`);
            sendTab({ type: "quick-eval-error", error: notice });
            break;
          }
          const result = { type: "quick-eval-result", grade: j.grade, score: j.score, reason: j.reason };
          const key = quickKey(msg.url) || quickKey(msg.title);
          if (key && j.score != null) {
            quickScores[key] = { score: j.score, grade: j.grade || "", reason: j.reason || "" };
            chrome.storage.local.set({ quickScores });
            notifyQuickUpdated();
          }
          announce(result);
          sendTab(result);
        } catch (err) {
          sendTab({ type: "quick-eval-error", error: "快评不可用：本地 web 服务/接口异常" });
        }
        sendResponse({ ok: true });
        break;
      }
      case "drive-scan": {
        // 探索页发起(经 localhost 桥转发)→ 查/开三站 tab 并驱动采集(E2)。异步
        // 完成,稍后 sendResponse,保持通道打开。失败不影响响应:错误落 tasks 内。
        // sender 带过来是为了记住探索页 tab(收尾切回它,E9)。
        driveScan(msg, sender).then((r) => sendResponse(r));
        break;
      }
      case "ext-ping": {
        // 连通性探测(探索页切换采集驱动前走一遍,ADR-0007 E6):SW 活着即答 ok。
        sendResponse({ ok: true });
        break;
      }
      case "zp-get-state": {
        // 智联职位 url 数据源:扩展 isolated world 读不到 window.__INITIAL_STATE__
        // (页面主世界属性隔离,ADR-0007 时代直接可读已退化)。用 chrome.scripting
        // programmatic 注入到 MAIN world 读取(命中页面 CSP script-src,扩展注入豁免),
        // 精简 {url,name,city}[] 回传 content script,由它写 html[data-zpstate] 缓存。
        const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;
        if (!tabId) {
          sendResponse({ ok: false, error: "no tab" });
          break;
        }
        chrome.scripting
          .executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => {
              try {
                const L = (window && window.__INITIAL_STATE__ && window.__INITIAL_STATE__.positionList) || [];
                return L.map((p) => ({ url: (p && (p.positionUrl || p.positionURL)) || "", name: (p && p.name) || "", city: (p && p.workCity) || "" }));
              } catch (e) {
                return [];
              }
            },
          })
          .then((res) => {
            const list = (res && res[0] && Array.isArray(res[0].result) && res[0].result) || [];
            sendResponse({ ok: true, list });
          })
          .catch((err) => {
            sendResponse({ ok: false, error: String((err && err.message) || err) });
          });
        break;
      }
      case "zp-fetch-pages": {
        // 智联翻页采集(MAIN world):SSR 首屏只 20 条,页面自身 load-more 的 XHR
        // 实测会静默挂起(风控),但同一 /c/i/search/positions 接口从页面上下文
        // 直接 POST 稳定可用(带登录 cookie)。注入主世界循环拉 pageIndex 2..N,
        // 精简 {url,title,company,salary,city}[] 回传 content script 直喂采集
        // 累积器 — 绕开 DOM 滚动与页面内部状态,职位 url 用 number 拼规范的
        // /jobdetail/{number}.htm(与 SSR positionList 同格式,去重键统一)。
        const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;
        if (!tabId) {
          sendResponse({ ok: false, error: "no tab" });
          break;
        }
        chrome.scripting
          .executeScript({
            target: { tabId },
            world: "MAIN",
            func: async () => {
              try {
                const st = (window && window.__INITIAL_STATE__) || {};
                const q = st.queryParams || {};
                const kw = q.kw || "";
                const jl = q.jl || "";
                const at = (st.cookiesData || {}).at || "";
                const rt = (st.cookiesData || {}).rt || "";
                const actionid = (st.statBaseData || {}).actionid || "";
                const resumeNumber = st.resumeNumber || "";
                const pageSize = st.pageSize || 20;
                if (!kw || !at || !rt) return { ok: false, error: "missing kw/at/rt" };
                const base =
                  "https://fe-api.zhaopin.com/c/i/search/positions?at=" +
                  encodeURIComponent(at) + "&rt=" + encodeURIComponent(rt) +
                  "&platform=13&version=0.0.0";
                const metas = [];
                let count = 0;
                const MAX_PAGES = 25; // 安全上限 25*20=500,超 SCAN_MAX 由累积器截断
                for (let p = 2; p <= MAX_PAGES; p++) {
                  // 参数镜像页面自身 load-more 请求(登录态 B 分支):order=0 +
                  // sortType=DEFAULT,anonymous=0,actionid/resumeNumber 来自 SSR state。
                  const body = {
                    S_SOU_FULL_INDEX: kw,
                    S_SOU_WORK_CITY: jl,
                    order: 0,
                    actionid,
                    pageSize,
                    pageIndex: p,
                    cvNumber: resumeNumber,
                    at,
                    rt,
                    eventScenario: "pcSearchedSouSearch",
                    anonymous: 0,
                    resumeNumber,
                    clickFilterBlackCompany: false,
                    platform: 13,
                    version: "0.0.0",
                    sortType: "DEFAULT",
                  };
                  const r = await fetch(base, {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                  });
                  if (!r.ok) break;
                  const j = await r.json().catch(() => null);
                  if (!j || j.code !== 200 || !j.data || !Array.isArray(j.data.list)) break;
                  if (typeof j.data.count === "number" && j.data.count > 0) count = j.data.count;
                  for (const it of j.data.list) {
                    if (!it || !it.number) continue;
                    metas.push({
                      url: "https://www.zhaopin.com/jobdetail/" + it.number + ".htm",
                      title: it.name || "",
                      company: it.companyName || "",
                      salary: it.salary60 || "",
                      city: it.workCity || "",
                    });
                  }
                  if (j.data.list.length < pageSize) break; // 末页不满 = 到头
                  if (count && p * pageSize >= count) break; // 已覆盖总数
                  await new Promise((res) => setTimeout(res, 350)); // 节流降风控
                }
                return { ok: true, count, metas };
              } catch (e) {
                return { ok: false, error: String((e && e.message) || e) };
              }
            },
          })
          .then((res) => {
            const r = (res && res[0] && res[0].result) || { ok: false, error: "no result" };
            sendResponse(r);
          })
          .catch((err) => {
            sendResponse({ ok: false, error: String((err && err.message) || err) });
          });
        break;
      }
      case "scan-status": {
        // 探索页 2s 轮询驱动状态:哪些平台仍在采集(activeDrives 键,key=`source|url`,
        // 拆词时同 source 多条 → 去回 source 再返回),配合 /api/explore/scan-progress
        // 的计数条数与前端拼"已采集 N 条"进度卡(06)。
        const activeSources = [];
        for (const key of activeDrives.keys()) {
          const source = String(key).split("|")[0];
          if (source && !activeSources.includes(source)) activeSources.push(source);
        }
        sendResponse({ ok: true, scanId: typeof msg.scanId === "string" ? msg.scanId : null, active: activeSources });
        // 应答之后再探活,不阻塞前端:采集端静默死亡(反爬跳验证页 / content script 被
        // 重注入)不会发 scan-done,只能我们主动问。见 ADR-0007 E10。
        probeDeadDrives().catch(() => {});
        break;
      }
      case "scan-batch": {
        // content script 分批上报 → SW 转发 web(单 fly,不阻塞心跳 ack)。
        sendResponse({ ok: true });
        const offers = Array.isArray(msg.offers) ? msg.offers : [];
        if (offers.length) {
          // 缓冲一份给探索页收尾取回渲染结果(不含于落库,仅前端展示镜像)。
          const sid = typeof msg.scanId === "string" && msg.scanId.trim() ? msg.scanId.trim() : "?";
          if (!scanOffers.has(sid)) scanOffers.set(sid, []);
          scanOffers.get(sid).push(...offers);
          relayScanBatch(sid, offers).catch((err) =>
            console.log("[bg] scan-batch relay error:", err && err.message)
          );
        }
        break;
      }
      case "scan-offers": {
        // 探索页收尾后取回本 scanId 采集到的 offer(结果渲染用)。
        const sid = typeof msg.scanId === "string" ? msg.scanId : "";
        sendResponse({ ok: true, offers: sid ? scanOffers.get(sid) || [] : [] });
        break;
      }
      case "scan-done": {
        // 平台采集收尾:先摘掉该 tab 的登记(允许后续再驱动),再按「登记表是否摘空」
        // 判定本次扫描是否真的结束了 —— 结束就收尾(把焦点切回探索页,E9)。
        // key 是 `${source}|${url}`,故按发送者 tab 的 tabId / URL 匹配清理 —— 拆词时
        // 同 source 多条 URL 各自独立登记,不能按 source 一把清。进度由 web 侧轮询
        // whats-new 呈现(E14),无需回传;仅响 ack(先响,收尾不阻塞采集端)。
        sendResponse({ ok: true });
        const doneTabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;
        const doneUrl = sender && sender.tab && sender.tab.url ? sender.tab.url : null;
        // 登记里记的 scanId 优先(它就是本次驱动的那个),content 回传的 scanId 兜底。
        const endedScanId =
          endDrivesForTab(doneTabId, doneUrl) ||
          (typeof msg.scanId === "string" && msg.scanId.trim() ? msg.scanId.trim() : null);
        // 登记已被整表清过(如探索页被关时)也走一次判定:幂等会挡掉重复,exploreTabId
        // 为 null 时自然什么都不切。没有 scanId 就无从归口,交给 onRemoved 那条路径。
        if (endedScanId) {
          runWrapUp({ drives: driveSnapshots(), scanId: endedScanId, wrapUpEnabled, exploreTabId });
        }
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })();
  return true; // async sendResponse
});

/** Tell every supported-board tab (zhipin/liepin/zhaopin) to re-fetch evaluated + re-render. */
async function notifyContentScripts() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    if (tab.url && /^https?:\/\/([^/]*\.)?(zhipin|liepin|zhaopin)\.com\//.test(tab.url)) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "evaluated-updated" });
      } catch {
        /* tab closed or content not injected — ignore */
      }
    }
  }
}

// ---- batch evaluation streaming ------------------------------------------

/** EVAL ports attached by the popup; each receives NDJSON-derived progress. */
const evalPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "eval") return;
  evalPorts.add(port);
  port.onDisconnect.addListener(() => evalPorts.delete(port));

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "batch-evaluate") return;
    runBatch(msg.urls, msg.cliId, msg.model).catch((err) => emit({ stage: "error", error: err.message }, port));
  });
});

function emit(ev, port) {
  try {
    port.postMessage(ev);
  } catch {
    /* port closed */
  }
}

function announce(ev) {
  for (const port of evalPorts) emit(ev, port);
}

// ---- 单职位评估：/api/run + /api/events（ADR-0051）---------------------
//
// 「评估本职位」以前也走批量端点（一个 URL 也吃批量编排），任务在 /jobs 里就被
// 记成「批量评估 · 1 项」。改走单任务链路后它与网页粘贴 URL 评估同形（单卡 +
// 报告跳转 + 台账步骤时间线）。事件折叠/选路这些判断全在 single-eval-pure.js，
// 此处只做 fetch 与 chrome 接线。
importScripts("single-eval-pure.js");
const SINGLE = self.__careerOpsSingleEvalPure;
if (!SINGLE) throw new Error("[bg] single-eval-pure.js 未加载:扩展文件不完整");

// 能力探测只是一次本机 GET，4s 足够；超时就当不支持（回落批量路）。
const CAPABILITY_TIMEOUT_MS = 4000;

/** 这台服务端的 /api/run 认不认 jdText？读不到就算不支持。 */
async function probeEvalRoute(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CAPABILITY_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/version`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return "batch";
    return SINGLE.pickEvalRoute(await res.json());
  } catch {
    return "batch";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单职位评估的单任务链路：POST /api/run 拿 runId → 订阅 /api/events 按 runId 过滤。
 *
 * 对详情页而言这与批量路无差异：收尾靠 evaluated-updated 与 3s 轮询，失败靠
 * `single-eval-error`。popup 也只认它已有的 stage 形状（事件由纯函数折叠而来）。
 */
async function runSingleViaApi({ base, url, cliId, model, jdText, company, tabId }) {
  announce({ stage: "start", total: 1, url });
  const failToTab = (message) => {
    announce({ stage: "error", error: message });
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: "single-eval-error", error: message }).catch(() => {});
    }
  };
  // SW 保活：读流不算活动事件，空闲 30s 就被 Chrome 终止（同 runBatch 里那段教训）。
  const keepalive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  const ctrl = new AbortController();
  let state = SINGLE.createRunState(url);
  try {
    const res = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "evaluate",
        input: url,
        cliId,
        model: model || undefined,
        // 内联 JD/雇主名（详情页 DOM 提取）：登录墙站靠它绕开服务端抓取。
        jdText: jdText || undefined,
        company: company || undefined,
      }),
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j || !j.runId) throw new Error((j && j.error) || `评估接口返回 ${res.status}`);
    const eres = await fetch(`${base}/api/events`, { signal: ctrl.signal, cache: "no-store" });
    if (!eres.ok || !eres.body) throw new Error(`事件通道不可用（${eres.status}）`);

    const reader = eres.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        // 总线是多任务复用的：只取自己这一路（帧层 keepalive 无 runId，自然落掉）。
        if (!frame || frame.runId !== j.runId || !frame.ev) continue;
        const step = SINGLE.consumeRunEvent(state, frame.ev);
        state = step.state;
        for (const ev of step.events) announce(ev);
        if (state.finished) break outer;
      }
    }
    // 没看到终态就断流，是连接问题不是评估失败（评估可能仍在后台跑完）——说清楚两者区别。
    if (!state.finished) throw new Error("事件通道提前结束（评估可能仍在后台运行，完成后徽章会刷新）");
    await loadEvaluated(base);
    await notifyContentScripts();
    // 评估结束：服务必然在线，强制刷新徽章（绕过节流，纠正评估期间的任何陈旧态）。
    await updateBadge(true).catch(() => {});
  } catch (err) {
    if (!state.finished) failToTab(err instanceof Error ? err.message : String(err));
  } finally {
    clearInterval(keepalive);
    ctrl.abort();
  }
}

/** Stream /api/batch-evaluate NDJSON to the popup, then refresh the map. */
async function runBatch(urls, cliId, model, opts) {
  if (!Array.isArray(urls) || urls.length === 0) {
    announce({ stage: "error", error: "没有可评估的职位" });
    return;
  }
  const base = `http://127.0.0.1:${await ensureLivePort()}`;

  const cfg = await resolveEvalConfig(base);
  const body = { urls, cliId: cliId || cfg.cliId, model: model || cfg.model || null };
  // 内联 JD/雇主名(仅详情页单评估场景;多 URL 批评估不带)。
  if (opts && opts.jdText) body.jdText = opts.jdText;
  if (opts && opts.company) body.company = opts.company;

  announce({ stage: "start", total: urls.length });
  // SW 保活:评估常跑 20-40s+,而 SW 空闲 30s 就会被 Chrome 终止 —— 正在读取的
  // 流式响应不算活动事件,SW 一死此 fetch 连接被切断,服务端 ReadableStream.cancel()
  // 触发 → worker 被 SIGTERM → 评估中断,且 evaluated-updated 永不送达 → 按钮卡
  // "评估中"。每 20s 调一次平台 API 制造真实活动事件,把 SW 保活到流读完。
  const keepalive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
  try {
    const res = await fetch(`${base}/api/batch-evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      let reason = `评估接口返回 ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.error) reason = j.error;
      } catch {
        /* non-json fallback */
      }
      throw new Error(reason);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let doneEv = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        // map web event → popup-progress shape
        if (ev.type === "status") announce({ stage: "status", text: ev.label });
        else if (ev.type === "text") announce({ stage: "text", text: ev.text });
        else if (ev.type === "keepalive") continue;
        else if (ev.type === "item")
          announce({ stage: "item", url: ev.url, ok: !!ev.ok, score: ev.score ?? null });
        else if (ev.type === "done") doneEv = { ok: ev.ok, failed: ev.failed };
        else if (ev.type === "error") announce({ stage: "error", error: ev.msg });
      }
    }
    announce({ stage: "done", ok: doneEv ? doneEv.ok : 0, failed: doneEv ? doneEv.failed : 0 });

    // Freshly evaluated → reload map and refresh badges on every zhipin tab.
    await loadEvaluated(base);
    await notifyContentScripts();
    // 评估结束：服务必然在线，强制刷新徽章（绕过节流，纠正评估期间的任何陈旧态）。
    await updateBadge(true).catch(() => {});
  } finally {
    clearInterval(keepalive);
  }
}