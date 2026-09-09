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
// 收尾后一次取回用于结果渲染(/api/explore/add 已落库为权威,此为前端展示镜像)。
const scanOffers = new Map();

/** 向某 tab 的 content script 发 start-scan(tab 未注入/已关闭时返回 {ok:false})。 */
async function tryStartScan(tabId, scanId) {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: "start-scan", scanId })) || { ok: false };
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
async function openAndDrive(source, url, scanId) {
  try {
    const key = driveKey(source, url);
    const tab = await chrome.tabs.create({ url });
    activeDrives.set(key, { scanId, tabId: tab.id });
    await waitTabLoaded(tab.id);
    let res = await tryStartScan(tab.id, scanId);
    if (!res || !res.ok) {
      await new Promise((r) => setTimeout(r, 800));
      res = await tryStartScan(tab.id, scanId);
    }
    if (res && res.ok) {
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
async function driveSource(source, url, scanId) {
  const spec = DRIVE_SOURCES[source];
  const key = driveKey(source, url);
  const active = activeDrives.get(key);
  if (active) return { source, status: "active", tabId: active.tabId, scanId: active.scanId };
  if (!spec) return { source, status: "failed", error: "unknown source" };
  return openAndDrive(source, url, scanId);
}

/**
 * 收「驱动扫描」:遍历请求的平台,查/开 tab 并驱动。scanId 缺省时生成一次会话 id
 * 并随结果返回(web 侧后续重放同 id 走路由幂等)。返回每平台 task 状态。
 */
async function driveScan(msg) {
  const scanId = typeof msg.scanId === "string" && msg.scanId.trim() ? msg.scanId.trim() : `ext-scan-${Date.now()}`;
  const requested = Array.isArray(msg.sources)
    ? msg.sources
        .map((s) => (s && typeof s.source === "string" ? s : { source: s }))
        .filter((s) => s && typeof s.source === "string" && DRIVE_SOURCES[s.source] && typeof s.url === "string" && /^https?:\/\//i.test(s.url))
    : [];
  if (requested.length === 0) return { ok: true, scanId, connected: true, tasks: [] };
  const tasks = [];
  for (const s of requested) {
    // 顺序驱动(每平台一次采集会话,避免同时弹多个搜索 tab)。每步失败不中断其它平台。
    tasks.push(await driveSource(s.source, s.url, scanId));
  }
  return { ok: true, scanId, connected: true, tasks };
}

/**
 * content script 分批上报 → SW 转发 web /api/explore/add(E5)。批量上报本身即活动
 * 事件,间隔常醒来 SW,无需额外 keepalive。环回同源走 host_permissions,CORS 豁免。
 */
async function relayScanBatch(scanId, offers) {
  const base = `http://127.0.0.1:${await ensureLivePort()}`;
  const res = await fetch(`${base}/api/explore/add`, {
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
        // Detail-page single evaluation — same engine as the popup batch
        // (runBatch → /api/batch-evaluate with one URL). Progress streams to any
        // attached popup eval port; on completion the map refreshes and content
        // scripts re-render badges (the detail button reads it via evaluated-updated).
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
        runBatch([url], msg.cliId, msg.model, { jdText, company }).catch(async (err) => {
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
        driveScan(msg).then((r) => sendResponse(r));
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
        // 平台采集收尾:清 activeDrives 对应此 tab URL 的登记(允许后续再驱动)。
        // key 是 `${source}|${url}`,故按发送者 tab 的 URL 匹配清理 —— 拆词时同
        // source 多条 URL 各自独立登记,不能按 source 一把清。进度由 web 侧轮询
        // whats-new 呈现(E14),无需回传;仅响 ack。
        const doneUrl = sender && sender.tab && sender.tab.url ? sender.tab.url : null;
        if (doneUrl) {
          for (const [key, entry] of activeDrives) {
            if (entry.tabId === sender.tab.id || key.endsWith(`|${doneUrl}`)) activeDrives.delete(key);
          }
        }
        sendResponse({ ok: true });
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
  } finally {
    clearInterval(keepalive);
  }
}