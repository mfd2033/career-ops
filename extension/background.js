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
//   • probe localhost:3000 /api/version → web port (3000 first, 3001-3040 only as
//     a dev-entry fallback; cache, re-probe)
//   • resolve cliId/model from the web config page's saved pick (/api/config)
//   • load + refresh the "evaluated" map (/api/report-status)
//   • run batch evaluation (/api/batch-evaluate) and stream NDJSON to the popup
//   • open the web report page for an evaluated position
//   • fetch report bodies (markdown / checkup HTML) on behalf of the detail-page
//     reader modal —— the page itself cannot (https 页面拉 http 本地服务被混合内容拦下)

// ---- port probing ---------------------------------------------------------

// 端口固定 3000（ADR-0063 决策 1），探测口径随之改为「3000 优先，不通再放宽到
// 3001-3040」。备选区间只为 dev 入口留着（`node local/dev-web.mjs -p 3101`，3000 上
// 通常跑着托盘壳）；常规路径只发 1 个探活请求。判定逻辑全在 probe-pure.js（可单测），
// 这里只做 fetch + abort 计时 + 缓存。
importScripts("probe-pure.js");
const PROBE = self.__careerOpsProbePure;
if (!PROBE) throw new Error("[bg] probe-pure.js 未加载:扩展文件不完整");
importScripts("events-bus-pure.js");
const EVENTS_BUS = self.__careerOpsEventsBusPure;
if (!EVENTS_BUS) throw new Error("[bg] events-bus-pure.js 未加载:扩展文件不完整");

const PRIMARY_PORT = PROBE.PRIMARY_PORT;
// 报告正文比版本探活大得多，也要等 Next 真的读完盘、渲染完响应，给 10s：超了就是
// 服务挂了 / 盘在另一台机器上转不动，报错比让用户盯着一个空弹窗强。
const FETCH_CONTENT_TIMEOUT_MS = 10000;

let cachedPort = null;
let probing = null;

// Latest DOM diagnostics reported by the content script (for the popup's
// debug box, since BOSS blocks DevTools by resizing/kicking the page).
let lastContentDiag = null;

// 最近一轮探测的逐端口结果（probe-pure.diagOf）：popup 诊断框据此分清「3000 超时 =
// 服务忙」与「3000 拒连 = 没起服务」。以前的单值 lastProbeErr 会被最后 settle 的那个
// 端口覆盖，区间扫描下永远是最慢的那个赢，看不出真因。
let lastProbe = { at: 0, port: null, reason: null, table: {}, inflight: 0 };

// ---- 本地请求在飞计数（诊断用）---------------------------------------------
//
// 同源 HTTP/1.1 只有 6 条连接。池子被长连接占满时，探针连 socket 都拿不到，
// abort 计时器一到就报 timeout —— 与「服务端事件循环被占住」的症状一模一样。
// 实测（6 条 /api/events 占满、池外裸连接 3ms ok）：primary 6001ms timeout、
// retry 4000ms timeout。这两个计数是唯一能在诊断里区分二者的东西。
let inflightLocal = 0;

function enterLocal() {
  inflightLocal += 1;
}

function exitLocal() {
  inflightLocal = Math.max(0, inflightLocal - 1);
}

/**
 * 一次 /api/version 探测 → probe-pure 的归一形状（附 port）。
 * 这里只负责把「超时 / 异常 / 状态码 / 正文」摊平成 classifyProbe 的入参。
 */
async function probeVersion(port, timeoutMs) {
  enterLocal();
  const started = Date.now();
  const ctrl = new AbortController();
  // 超时那一刻的在飞请求数：探针自己也算一条，所以池满时这个值会贴着 6。
  let inflightAtEnd = 0;
  const timer = setTimeout(() => {
    inflightAtEnd = inflightLocal;
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: ctrl.signal });
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      // 正文被截断 / 不是 JSON：abort 造成的不算「无效服务」，交给外层按超时判。
      if (ctrl.signal.aborted) throw e;
      body = null;
    }
    return { port, inflight: inflightAtEnd, ...PROBE.classifyProbe({ ms: Date.now() - started, status: res.status, body }) };
  } catch (e) {
    const timedOut = ctrl.signal.aborted || (e && e.name === "AbortError");
    return {
      port,
      inflight: inflightAtEnd,
      ...PROBE.classifyProbe({
        ms: Date.now() - started,
        timedOut,
        // 剩下的都是拒连 / CORS / host_permissions 缺失这类立刻失败的错
        error: timedOut ? null : (e && e.message) || String(e),
      }),
    };
  } finally {
    clearTimeout(timer);
    exitLocal();
  }
}

/** 已缓存端口的复核（返回布尔：这次是否仍然通）。 */
async function versionOk(port) {
  const r = await probeVersion(port, PROBE.PROBE_TIMEOUT_MS);
  return r.ok;
}

/** 备选区间 3001-3040 并发短扫（只为 dev 实例）。 */
function sweepAltPorts() {
  return Promise.all(PROBE.altPorts().map((port) => probeVersion(port, PROBE.ALT_PROBE_TIMEOUT_MS)));
}

/**
 * 采集一次：3000 主探 → 备选区间短扫 → 3000 二次复探（兜住冷启动的预热延迟）。
 * 三段结果一起交给 decideProbe 定端口，并留在 lastProbe 里供诊断。
 */
async function discoverPort() {
  const primary = await probeVersion(PRIMARY_PORT, PROBE.PROBE_TIMEOUT_MS);
  const alt = primary.ok ? [] : await sweepAltPorts();
  let retry = null;
  if (!primary.ok && !alt.some((o) => o.ok)) {
    retry = await probeVersion(PRIMARY_PORT, PROBE.RETRY_TIMEOUT_MS);
  }
  const d = PROBE.decideProbe({ primary, alt, retry });
  lastProbe = {
    at: Date.now(),
    port: d.port,
    reason: d.reason,
    table: PROBE.diagOf({ primary, alt, retry }),
    // 超时那一瞬的在飞请求数（取主探/复探里大的那个）。≥6 就是连接池被占满，
    // 而不是服务端慢 —— 这两种情况给用户的建议完全相反。
    inflight: Math.max(primary.inflight || 0, retry ? retry.inflight || 0 : 0),
  };
  return d.port;
}

function probePort() {
  if (cachedPort) return Promise.resolve(cachedPort);
  if (probing) return probing;
  probing = discoverPort().then(
    (port) => {
      probing = null;
      cachedPort = port;
      return cachedPort;
    },
    (err) => {
      // discoverPort 内部已吞掉所有网络错，这里只是不让 probing 卡在非 null 上。
      probing = null;
      throw err;
    },
  );
  return probing;
}

/** Drop the cached port so the next request re-probes (web restarted elsewhere). */
function invalidatePort() {
  cachedPort = null;
}

async function needPort() {
  const port = await probePort();
  if (port == null) throw new Error(portErrorText());
  return port;
}

/**
 * 探不通时给用户的那句话。
 *
 * timeout 与 refused 必须分开：前者是端口在听、服务进程在，只是没答复（事件循环被
 * 占住，或扩展自己把同源连接池占满）；后者才是真没起服务。把前者说成「未运行」
 * 会把用户指向一个根本没停的服务 —— 这正是本次排查里用户看到的那句话。
 */
function portErrorText() {
  const reason = lastProbe.reason;
  if (reason === "timeout") {
    const secs = Math.round(PROBE.PROBE_TIMEOUT_MS / 1000);
    const busy = lastProbe.inflight >= 6 ? "（扩展自身连接占满）" : "";
    return `本地服务在忙：${PRIMARY_PORT} 在 ${secs}s 内没答复${busy}；服务进程还在，稍后重试`;
  }
  if (reason === "http" || reason === "invalid") {
    return `${PRIMARY_PORT} 端口上的不是本项目的 web 服务（${reason}）；检查端口是否被别的程序占用`;
  }
  return `本地 web 服务未运行（${PRIMARY_PORT} 拒连，已放宽扫过 3001-3040）`;
}

/**
 * Port guaranteed live right now: verify the cached port first (it may have
 * gone away since it was probed), else re-probe. Prevents clicking an evaluated
 * badge from opening a dead localhost link when the dashboard restarted.
 */
async function ensureLivePort() {
  console.log("[bg] ensureLivePort cachedPort=", cachedPort);
  if (cachedPort && (await versionOk(cachedPort))) {
    console.log("[bg] cached port live:", cachedPort);
    return cachedPort;
  }
  invalidatePort();
  const p = await needPort();
  console.log("[bg] re-probed port:", p);
  return p;
}

// 本 SW 发往本机服务的普通请求统一走这里：fetch 没有默认超时，一个永远不回的响应
// 会一直占着浏览器对该源的连接（HTTP/1.1 同源上限 6 条），后面连 /api/version 探针
// 都只能在队尾等自己的 abort 计时 —— popup 就报「本地服务在忙」，而服务其实活着。
// ADR-0098 治的是服务端事件循环，治不了浏览器连接池。长连接（事件流 / NDJSON 批评估）
// 不走这里，它们的时长由评估本身决定。
const LOCAL_FETCH_TIMEOUT_MS = 15000;

async function localFetch(url, { timeoutMs = LOCAL_FETCH_TIMEOUT_MS, ...init } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  enterLocal();
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) {
      // 这次端口没答上来：丢掉缓存，让下一次探针重新发现（服务可能刚换端口/重启）。
      invalidatePort();
      throw new Error(`本地服务 ${timeoutMs}ms 未响应：${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    exitLocal();
  }
}

// ---- 共享事件通道（对齐服务端 ADR-0020 的多路复用总线）----------------------
//
// 服务端 /api/events 本来就是「一条连接多路复用所有 run」（帧 `{runId, ev}`，ev 带
// 单调 seq）。改造前扩展没吃这个设计：每次单职位评估各 fetch 一条 /api/events，
// 几条评估叠上快评就能占满同源 6 条连接，探针于是拿不到 socket、6s 后 abort ——
// 用户看到「服务在忙 / 未检测到服务」，服务其实 1-3ms 就能答。
//
// 现在全 SW 共用一条通道，runSingleViaApi 只是按 runId 订阅。
const EVENTS_IDLE_TIMEOUT_MS = 45000; // 服务端 15s 一帧心跳，三拍不来即判死
const EVENTS_RECONNECT_DELAY_MS = 1000;
const EVENTS_RECONNECT_MAX = 3;

const EVENTS_IDLE_CLOSE_MS = 60000; // 没有订阅者后留 60s，然后放掉这条连接让 SW 能睡

const runEvents = EVENTS_BUS.createBus();
// { base, ctrl, attempt }；null = 没建或已彻底放弃
let eventsChannel = null;
let channelIdleClose = null;

/** 确保通道在（不等待建连：总线会缓冲，订阅者按 runId 收）。 */
function ensureEventsChannel(base) {
  if (eventsChannel && eventsChannel.base === base && !eventsChannel.ctrl.signal.aborted) return;
  // 先换对象再 abort 旧连接：旧 pump 的 catch 会看到 ctrl 不匹配而放弃重连，
  // 同时旧连接立刻释放（否则换端口后老监听上那条会一直挂着占池子）。
  const prev = eventsChannel;
  const ctrl = new AbortController();
  eventsChannel = { base, ctrl, attempt: 0 };
  if (prev) prev.ctrl.abort();
  void pumpEventsChannel(base, ctrl, 0);
}

/**
 * 没有订阅者时延迟关掉通道。
 *
 * 常驻的连接会一直让 MV3 service worker 处于活跃态（未结束的 fetch 算活动），
 * SW 就再也睡不下去。所以评估结束后留 60s 热身窗口，之后放掉。
 */
function scheduleChannelIdleClose() {
  if (channelIdleClose) clearTimeout(channelIdleClose);
  channelIdleClose = setTimeout(() => {
    channelIdleClose = null;
    if (!eventsChannel || runEvents.subscribers() > 0) return;
    const ctrl = eventsChannel.ctrl;
    eventsChannel = null;
    ctrl.abort(); // pump 的 catch 见到 eventsChannel 已置空 → 不重连
  }, EVENTS_IDLE_CLOSE_MS);
}

/**
 * 读 /api/events 到断流为止。断流后按退避重连：服务端会在重连时整段回放
 * 所有在飞 run 的缓冲，events-bus 的 seq 去重保证重放不产生重复步骤 ——
 * 所以一次瞬时抖动不该让正在跑的评估直接失败。
 */
async function pumpEventsChannel(base, ctrl, attempt) {
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(), EVENTS_IDLE_TIMEOUT_MS);
  };
  enterLocal();
  // 建连阶段也要计时：服务端在没有 in-flight run 时不立刻回响应头（首帧要等 15s
  // 心跳），万一连头都不回，不能让它无限挂着变成一条僵尸连接。
  armIdle();
  try {
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok || !res.body) throw new Error(`事件通道不可用（${res.status}）`);
    armIdle();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
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
        runEvents.publish(frame);
      }
    }
    throw new Error("事件通道提前结束");
  } catch (err) {
    // 已被更新的通道取代（端口变化 / 主动重建）：不重连，也不要覆盖新状态。
    if (!eventsChannel || eventsChannel.ctrl !== ctrl) return;
    const reason = err instanceof Error ? err.message : String(err);
    const next = attempt + 1;
    if (next > EVENTS_RECONNECT_MAX) {
      eventsChannel = null;
      runEvents.failAll(`事件通道断开（已重试 ${EVENTS_RECONNECT_MAX} 次）：${reason}`);
      return;
    }
    const nextCtrl = new AbortController();
    eventsChannel = { base, ctrl: nextCtrl, attempt: next };
    setTimeout(() => {
      if (eventsChannel && eventsChannel.ctrl === nextCtrl) void pumpEventsChannel(base, nextCtrl, next);
    }, EVENTS_RECONNECT_DELAY_MS);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    exitLocal();
  }
}

/** 订阅某条 run；返回退订函数（不立刻关共享通道 —— 它要留给下一个评估）。 */
function subscribeRunEvents(base, runId, handler) {
  if (channelIdleClose) {
    clearTimeout(channelIdleClose);
    channelIdleClose = null;
  }
  ensureEventsChannel(base);
  const off = runEvents.subscribe(runId, handler);
  return function unsubscribe() {
    off();
    if (runEvents.subscribers() === 0) scheduleChannelIdleClose();
  };
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
    const cfg = await (await localFetch(`${base}/api/config`, { timeoutMs: 5000 })).json();
    if (cfg && typeof cfg.cliId === "string" && cfg.cliId) cliId = cfg.cliId;
    if (cfg && typeof cfg.model === "string" && cfg.model) model = cfg.model;
    if (cfg && cfg.unknownEmployer === "agency") unknownEmployer = "agency";
  } catch {
    /* server config missing — fall back below */
  }
  if (!cliId) {
    try {
      // /api/clis 冷启动要探一遍已装 CLI（ADR-0098 后约 3s），给 10s 上限。
      const d = await (await localFetch(`${base}/api/clis`, { timeoutMs: 10000 })).json();
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

let evaluatedLoading = null;

async function loadEvaluated(base) {
  // 并发合并：多个 tab / 多轮刷新会同时要这份索引，/api/report-status 体积大，并发几份
  // 就把同源连接池占满，连探针都没位置。一次只跑一份，其余等同一次结果。
  if (evaluatedLoading) return evaluatedLoading;
  evaluatedLoading = (async () => {
    try {
      const res = await localFetch(`${base}/api/report-status`);
      console.log("[bg] loadEvaluated", base, "status=", res.status);
      const j = await res.json();
      evaluated = j && typeof j === "object" ? j : {};
      console.log("[bg] report-status keys=", Object.keys(evaluated).length);
      return evaluated;
    } catch (err) {
      // 保留上一次成功的索引：瞬时超时不该把全站徽章抹成空白，下一轮刷新会再来。
      console.log("[bg] loadEvaluated error:", err.message);
      return evaluated;
    }
  })();
  try {
    return await evaluatedLoading;
  } finally {
    evaluatedLoading = null;
  }
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

// ADR-0066：本次扫描开出的采集窗口账（scanId → [{scanId,windowId,tabId,source,originalUrl}]）。
// activeDrives 会随每条采集结束逐条摘除，收尾时点已读不到"这次一共开了哪些窗口"，
// 故单列一份存活到整轮 settle 的窗口账，供关窗判定用。窗口/其 tab 被关时同步剔除。
const scanWindows = new Map();
function recordScanWindow(rec) {
  if (!rec || typeof rec.windowId !== "number") return;
  const list = scanWindows.get(rec.scanId) || [];
  list.push(rec);
  scanWindows.set(rec.scanId, list);
}
function dropScanWindow(tabId) {
  for (const [sid, list] of scanWindows) {
    const kept = list.filter((r) => r.tabId !== tabId);
    if (kept.length === list.length) continue;
    if (kept.length) scanWindows.set(sid, kept);
    else scanWindows.delete(sid);
  }
}

// scanId → DiscoveredOffer[];content script 分批上报的增量本地缓冲,供探索页在采集
// 收尾后一次取回用于结果渲染(ADR-0021:上报只记「见过」台账,结果区是这些候选的
// 展示面;入管由用户在结果区勾选后显式确认)。
const scanOffers = new Map();

// ---- 扫描收尾(ADR-0007 E9) ------------------------------------------------

// 发起本次扫描的探索页 tab(由 localhost 桥的 sender.tab 给出),随 drive-scan 一起
// 进来。同一时刻只有一次探索页驱动的扫描(前端 runningRef 拦连点),故用单份模块状态
// 而非按 scanId 存表。
let exploreTabId = null;

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

/** 收尾判定 → 动作。ADR-0066：settle 为真(本次扫描全部采完)则按保护规则关闭本次
 *  开出的采集窗口，并把焦点还给探索页所在窗口。切旧「激活探索页 tab」行为已删除。 */
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
    decision.settle ? `→ close windows for ${decision.scanId}` : "(not settled)",
  );
  if (decision.settle) closeScanWindows(decision.scanId, facts.exploreTabId).catch(() => {});
  return decision;
}

/** 关闭本次 scanId 应关的采集窗口：读各窗口当前 URL → decideCloseWindows 判保护
 *  → 关之，最后把焦点还给探索页所在窗口。已被用户关掉的 tab 读 URL 会抛错，按原样剔除。 */
async function closeScanWindows(scanId, exploreTabId) {
  const recs = scanWindows.get(scanId);
  scanWindows.delete(scanId);
  const facts = [];
  for (const r of recs || []) {
    let currentUrl = r.originalUrl;
    try {
      const tab = await chrome.tabs.get(r.tabId);
      if (tab && typeof tab.url === "string") currentUrl = tab.url;
    } catch {
      /* tab 已关：currentUrl 回落 originalUrl，归一化相等→被当作应关；窗口关不存在→静默 */
    }
    facts.push({ scanId: r.scanId, windowId: r.windowId, originalUrl: r.originalUrl, currentUrl, isDetailPath: isDetailPathFor(r.source, currentUrl), isAuthPage: isAuthUrl(currentUrl) });
  }
  const { closeWindowIds, keepWindowIds } = WRAPUP.decideCloseWindows({ drives: facts, scanId });
  console.log(
    "[bg] closeScanWindows", scanId,
    "close:", closeWindowIds.join(",") || "(none)",
    "keep:", keepWindowIds.join(",") || "(none)",
    "urls:", facts.map((f) => `${f.windowId}=${f.currentUrl}`).join(" | "),
  );
  for (const wid of closeWindowIds) {
    try {
      await chrome.windows.remove(wid); // Chrome 关窗 API 是 windows.remove（没有 windows.close）
      console.log("[bg] closeScanWindows closed", wid);
    } catch (e) {
      console.log("[bg] closeScanWindows FAILED to close", wid, ":", (e && e.message) || String(e));
    }
  }
  if (exploreTabId != null) await refocusExploreWindow(exploreTabId);
}

/** 把探索页所在窗口提到前台并激活其 tab（ADR-0066：多窗口扫完后焦点回探索页）。 */
async function refocusExploreWindow(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    activateExploreTab(tabId);
  } catch {
    /* 探索页 tab 已关：静默 */
  }
}

/** 粗判登录/验证页 URL（重定向到登录页多半已被 host/路径变更盖盖，这里给同站登录态页兜底）。 */
function isAuthUrl(url) {
  if (typeof url !== "string") return false;
  return /(\/(login|signin|register)(\b|[/?#])|web\/user|passport|\/(verify|captcha|security|checkcode)(\b|[/?#]))/i.test(url);
}

/** 该站当前 URL 是否职位详情页（用 DRIVE_SOURCES[source].isDetail 判 pathname）。
 *  用作关窗保护的"用户已点进去看"信号——比 pathname 与原始 URL 是否相等更准，
 *  不会误伤 BOSS 这类会把列表页自身路径 job→jobs 改写的站。 */
function isDetailPathFor(source, url) {
  const spec = DRIVE_SOURCES[source];
  if (!spec || typeof url !== "string") return false;
  try {
    return !!spec.isDetail(new URL(url).pathname);
  } catch {
    return false;
  }
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
    runWrapUp({ drives: driveSnapshots(), scanId, exploreTabId });
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
    // ADR-0066 决议 4：探索页被关=中止采集，本次开出的采集窗口按同一保护规则关掉，
    // 并把窗口账清空——否则窗口留在桌面、scanWindows 残留到下次扫描。探索页已关，
    // closeScanWindows 的焦点归还传 null 自然跳过。
    for (const sid of [...scanWindows.keys()]) closeScanWindows(sid, null).catch(() => {});
    exploreTabId = null; // 之后迟到的 scan-done 只会 settle,不再切焦点
    console.log("[bg] explore tab closed → stopped", abort.stopTabIds.length, "drive(s)");
    return;
  }
  const endedScanId = endDrivesForTab(tabId, null);
  dropScanWindow(tabId); // 采集窗口/其 tab 被用户关掉 → 从窗口账剔除，免得收尾去关已不存在的窗口
  if (endedScanId) {
    runWrapUp({ drives: driveSnapshots(), scanId: endedScanId, exploreTabId });
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

/** 新开搜索窗口、等加载完成、驱动扫描;content 未及时就绪时多等 800ms 重试一轮。
 *  ADR-0066:每平台一个下半屏独立窗口(取代在当前窗口开 tab)。bounds 来自探索页
 *  (window.screen 算好下发),缺失或尺寸非法时退回默认窗口位置。 */
async function openAndDrive(source, url, scanId, maxCount, bounds) {
  try {
    const key = driveKey(source, url);
    const winOpts = { url };
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      winOpts.left = bounds.left;
      winOpts.top = bounds.top;
      winOpts.width = bounds.width;
      winOpts.height = bounds.height;
    }
    const win = await chrome.windows.create(winOpts);
    // chrome.windows.create 的创建期 bounds 在部分环境(尤其 SW 刚唤醒的第一个窗口)会被
    // 忽略、退化成级联默认位置。拿到窗口后用 windows.update 再钉一次位置/尺寸——这是
    // 已知更可靠的做法;create 已生效时 update 为幂等空操作。
    if (win && win.id != null && bounds && bounds.width > 0 && bounds.height > 0) {
      await chrome.windows
        .update(win.id, { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, state: "normal" })
        .catch(() => {});
    }
    const tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : undefined;
    activeDrives.set(key, { scanId, tabId, windowId: win.id, originalUrl: url, started: false });
    await waitTabLoaded(tabId);
    let res = await tryStartScan(tabId, scanId, maxCount);
    if (!res || !res.ok) {
      await new Promise((r) => setTimeout(r, 800));
      res = await tryStartScan(tabId, scanId, maxCount);
    }
    if (res && res.ok) {
      // 握上手才算"这个采集端应该活着":在此之前无应答是正常的,存活探测必须让开这段窗口。
      const entry = activeDrives.get(key);
      if (entry) entry.started = true;
      recordScanWindow({ scanId, windowId: win.id, tabId, source, originalUrl: url });
      return { source, status: "created", tabId, windowId: win.id, scanId: res.scanId || scanId };
    }
    activeDrives.delete(key); // 启动失败:清登记,允许后续重试驱动
    return { source, status: "failed", tabId, windowId: win.id, error: (res && res.error) || "content not ready" };
  } catch (e) {
    return { source, status: "failed", error: (e && e.message) || String(e) };
  }
}

/**
 * 驱动单个平台:查既存 hosts 命中 tab,优先取列表页驱动;都不可用/被拒则新开搜索
 * tab。activeDrives 按 {source,url} 登记成功来源,scan-done 时清除,避免重复驱动。
 */
async function driveSource(source, url, scanId, maxCount, bounds) {
  const spec = DRIVE_SOURCES[source];
  const key = driveKey(source, url);
  const active = activeDrives.get(key);
  if (active) return { source, status: "active", tabId: active.tabId, windowId: active.windowId, scanId: active.scanId };
  if (!spec) return { source, status: "failed", error: "unknown source" };
  return openAndDrive(source, url, scanId, maxCount, bounds);
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
        .map((s) => ({ source: s.source, url: s.url, maxCount: typeof s.maxCount === "number" && s.maxCount > 0 ? s.maxCount : undefined, bounds: s.bounds && typeof s.bounds === "object" ? s.bounds : undefined }))
    : [];
  // 收尾上下文:web-bridge 是注入在本地面板上的 content script,故 sender.tab 就是发起
  // 本次扫描的探索页 tab —— 不用猜端口,也不用从页面 URL 反推。扫完据此把焦点还回此窗口。
  exploreTabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;
  if (requested.length === 0) return { ok: true, scanId, connected: true, tasks: [] };
  const tasks = [];
  for (const s of requested) {
    // 顺序驱动(每平台一次采集会话,避免同时弹多个搜索 tab)。每步失败不中断其它平台。
    tasks.push(await driveSource(s.source, s.url, scanId, s.maxCount, s.bounds));
  }
  // 全部平台一个都没起来:openAndDrive 是先开 tab 再握手,失败时 tab 留着(只摘登记),
  // 用户已经被带到那个空 tab 上 —— 立即收尾把他送回探索页(E9)。部分失败不在此列,
  // 仍等成功启动的平台跑完(它们各自的 scan-done 会触发收尾)。
  if (!tasks.some((t) => t && (t.status === "created" || t.status === "active"))) {
    runWrapUp({ drives: driveSnapshots(), scanId, exploreTabId });
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
  const res = await localFetch(`${base}/api/explore/seen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scanId, offers }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) console.log(`[bg] scan-batch relay ${res.status}:`, j && j.error);
  return j;
}

// ---- 报告跳转目标解析（ADR-0055）------------------------------------------
//
// 点击「已评估」徽章不再无条件新开标签页：先在已开标签页里找一个本项目 web 端，
// 命中就激活它并把报告开在它里面，找不到才退回 chrome.tabs.create。候选筛选、端口
// 优先、「最近活跃」近似规则、同 URL 幂等、兜底与报错分支全在 report-target-pure.js
// （可单测），此处只做 chrome 接线。
importScripts("report-target-pure.js");
const REPORT_TARGET = self.__careerOpsReportTargetPure;
if (!REPORT_TARGET) throw new Error("[bg] report-target-pure.js 未加载:扩展文件不完整");

// 前端路由跳转应声窗口:页面 hydrate 后是同步应答的;这段只用来兜住「还没 hydrate /
// 老版本 web 没有监听器」——那时必须回退整页导航,不能让点击悬空。
const NAV_ROUTE_TIMEOUT_MS = 1200;

/**
 * 请 web 端在自己页面里前端路由跳到 path（不刷新，ADR-0055 修订）。
 * 经 web-bridge.js 的 career-navigate 入口转发给页面,页面 ExtNavBridge 跳转后回 ack。
 * 没 ack（旧版 web / 未 hydrate / content script 不在）→ 用 url 整页导航兜底。
 * @returns {Promise<"routed"|"reloaded">}
 */
async function navigateInWebTab(tabId, path, url) {
  const ack = await Promise.race([
    chrome.tabs.sendMessage(tabId, { type: "career-navigate", path }).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), NAV_ROUTE_TIMEOUT_MS)),
  ]);
  if (ack && ack.ok) return "routed";
  await chrome.tabs.update(tabId, { url, active: true });
  return "reloaded";
}

/**
 * open-report / open-web 共用的候选池与「当前窗口」采集（ADR-0055 / ADR-0078）。
 * 「当前窗口」取最近聚焦窗口，取不到则退化用发起本次点击的招聘站 tab 所在窗口
 * （content script 的 sender.tab 就是它）。
 */
async function collectWebTabContext(sender) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  let currentWindowId = null;
  try {
    const w = await chrome.windows.getLastFocused({});
    currentWindowId = w && typeof w.id === "number" ? w.id : null;
  } catch {
    /* 窗口接口不可用：退到 sender.tab（下面兜） */
  }
  if (currentWindowId == null && sender && sender.tab) {
    currentWindowId = typeof sender.tab.windowId === "number" ? sender.tab.windowId : null;
  }
  return { tabs, currentWindowId };
}

/**
 * 复用分支的统一 choreography（ADR-0055 修订 / ADR-0078）：先把 web 端标签页提到
 * 前台（聚焦先于跳转，点击立即有反馈），再按落点性质决定怎么「到达」。返回最终 mode。
 *   - forceReload：落点不是前端路由页（体检 API 端点）→ 整页导航；
 *   - 其余：navigate=true 走前端路由（无 ack 回退整页），false 只聚焦不重载。
 * 不 tabs.move 搬家，也不关不动招聘站页面——用户切回去仍在原职位页。
 */
async function revealWebTab(target, forceReload) {
  await chrome.tabs.update(target.tabId, { active: true });
  if (target.windowId != null) {
    await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
  }
  if (forceReload) {
    await chrome.tabs.update(target.tabId, { url: target.url, active: true });
    return "reloaded";
  }
  return target.navigate ? await navigateInWebTab(target.tabId, target.path, target.url) : "focused";
}

/**
 * open-report 的落点解析与跳转编排（ADR-0055 修订 / ADR-0078）。open-web 带报告号
 * 时也走这条链（🌐 的主落点是当前职位的报告页）。返回值直接作为 sendResponse 载荷。
 */
async function resolveReportJump(msg, sender) {
  // 端口探测失败即报错、不跳转：把一个已经连不上的页面推到用户面前，比直说
  // 「web 服务没跑」更困惑（ADR-0055 决策 8，纯层负责把 null port 变成 error）。
  // 注意探测与 API base 走 127.0.0.1，而打开给用户看的页面一律用 localhost——
  // 两者是不同 origin，勿「顺手统一」（见 report-target-pure.js 的 reportUrl）。
  const port = await ensureLivePort().catch(() => null);
  // 候选池与「当前窗口」的采集口径 open-report / open-web 共用（ADR-0078）。
  const { tabs, currentWindowId } = await collectWebTabContext(sender);
  const target = REPORT_TARGET.pickReportTarget({
    livePort: port,
    tabs,
    currentWindowId,
    num: msg.num,
    kind: msg.kind,
  });
  if (target.action === "error") return { ok: false, error: target.error };
  if (target.action === "create") {
    // 服务活着但没有任何 web 端标签页：退回今天的行为，别让用户点不动徽章。
    await chrome.tabs.create({ url: target.url });
    return { ok: true, reportUrl: target.url, mode: "created" };
  }
  // 复用：先把 web 端标签页提到前台，再请它自己前端路由跳过去（不刷新页面，
  // ADR-0055 修订）；web 端没应声才回退整页导航。体检报告的落点是一个 API
  // 端点（直接返回那份自包含 HTML），不是 web 端的应用路由：让页面自己
  // router.push 过去会撞上 404 页，只能整页导航（forceReload）。
  const mode = await revealWebTab(target, msg.kind === "checkup" && target.navigate);
  return { ok: true, reportUrl: target.url, mode };
}

// ---- 列表卡「评估中 / 排队中」------------------------------------------------
//
// 扩展发起的评估经 web 端 /api/run 进全局并发池，池里此刻在跑 / 在排队的任务由
// /api/active-runs 统一给出（running + queued 两段，都带 runId 与 url）。列表卡靠它
// 知道自己这一条是不是正在评估、以及在排队第几位 —— 卡片本身收不到任何任务事件。
//
// 轮询频率由 content script 决定（3s）。这里再加 2s 的短缓存：同一屏上十几种卡片
// 一次 applyAllInjections 会各自问一次，没有缓存就等于一次批量打十六七个请求。
const ACTIVE_RUNS_TTL_MS = 2000;
let activeRunsCache = { at: 0, payload: null };

/** 只把卡片需要的字段透出去：runId / url / 状态 / 排队位次。 */
function normalizeActiveRuns(snapshot) {
  const pick = (t, status) => {
    if (!t || typeof t !== "object") return null;
    if (typeof t.runId !== "string" || !t.runId) return null;
    const out = { runId: t.runId, url: typeof t.url === "string" ? t.url : "", status };
    if (status === "queued" && Number.isFinite(Number(t.position))) out.position = Number(t.position);
    return out;
  };
  const running = (snapshot && Array.isArray(snapshot.running) ? snapshot.running : []).map((t) => pick(t, "running")).filter(Boolean);
  const queued = (snapshot && Array.isArray(snapshot.queued) ? snapshot.queued : []).map((t) => pick(t, "queued")).filter(Boolean);
  return { running, queued };
}

async function loadActiveRuns() {
  const now = Date.now();
  if (activeRunsCache.payload && now - activeRunsCache.at < ACTIVE_RUNS_TTL_MS) return activeRunsCache.payload;
  let payload;
  const port = await ensureLivePort().catch(() => null);
  if (port == null) {
    payload = { ok: false, connected: false, running: [], queued: [] };
  } else {
    try {
      // 「评估中/排队中」胶囊每 3s 轮询一次，读不到就该尽快回落，不能无限挂着占连接。
      const res = await localFetch(`http://127.0.0.1:${port}/api/active-runs`, { timeoutMs: 5000 });
      const j = res.ok ? await res.json().catch(() => null) : null;
      payload = j
        ? { ok: true, connected: true, ...normalizeActiveRuns(j) }
        : { ok: false, connected: true, error: `任务列表读不出来（${res.status}）`, running: [], queued: [] };
    } catch (err) {
      payload = { ok: false, connected: true, error: `任务列表读取失败：${(err && err.message) || err}`, running: [], queued: [] };
    }
  }
  activeRunsCache = { at: now, payload };
  return payload;
}

/** 「评估中 / 排队中」胶囊的落点解析与跳转（同 resolveReportJump 的编排）。 */
async function resolveJobJump(msg, sender) {
  const port = await ensureLivePort().catch(() => null);
  const { tabs, currentWindowId } = await collectWebTabContext(sender);
  const target = REPORT_TARGET.pickJobTarget({ livePort: port, tabs, currentWindowId, runId: msg && msg.runId });
  if (target.action === "error") return { ok: false, error: target.error };
  if (target.action === "create") {
    await chrome.tabs.create({ url: target.url });
    return { ok: true, jobUrl: target.url, mode: "created" };
  }
  const mode = await revealWebTab(target, false);
  return { ok: true, jobUrl: target.url, mode };
}

// ---- 智联列表卡的 JD 代抓 ----------------------------------------------------
//
// 智联搜索页是 i.zhaopin.com / www.zhaopin.com、收藏页是 i.zhaopin.com 抓
// jobs.zhaopin.com 的详情页，页面上下文被 CORS 挡死（实测 Failed to fetch）。
// service worker 有 host_permissions（https://*.zhaopin.com/*），由它代抓再把
// HTML 文本回给 content script，解析仍在站点侧（选择器归 site-*.js）。
//
// 只放白名单三站：这条消息的入参是页面给的一个 URL，扩成任意 URL 等于把 SW 变成
// 一个跳过 CORS 的通用代理。体积上限针对「剥掉脚本后的净标记」——智联真实详情页
// 实测可到 1.6MB+（内嵌大量 JSON/脚本，2026-11 实例 1.69MB 仍是正常职位页），
// 原始体积已无判别力；剥掉 script/style/noscript/注释后正常页远小于 400KB，
// 超限才是异常膨胀。被拦到验证/登录页由消费端「JD 文本过短」兜住。
const FETCH_HTML_TIMEOUT_MS = 15000;
const FETCH_HTML_MAX_CHARS = 400000;
const FETCH_HTML_HOSTS = [/(^|\.)zhaopin\.com$/i, /(^|\.)zhipin\.com$/i, /(^|\.)liepin\.com$/i];

async function fetchDetailHtml(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || ""));
  } catch {
    return { ok: false, error: "详情页地址无效" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "详情页地址无效" };
  if (!FETCH_HTML_HOSTS.some((re) => re.test(u.hostname))) return { ok: false, error: "详情页地址不在支持的站点内" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_HTML_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), { credentials: "include", signal: ctrl.signal });
    const html = await res.text();
    if (!res.ok) return { ok: false, error: `详情页抓取失败：HTTP ${res.status}` };
    // 剥掉脚本/样式/注释再校验体积：返回给消费端的是瘦身后的标记（消费端只用
    // DOM 选择器取正文），顺带把 1.6MB+ 的消息回传体积也压下来。
    const slim = html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
    if (slim.length > FETCH_HTML_MAX_CHARS) {
      // 净标记仍超限才是真异常：带出页面标题与最终 URL，复制错误信息即可定位。
      const m = slim.match(/<title[^>]*>([^<]{0,120})/i);
      const title = m ? m[1].trim() : "";
      const finalUrl = res.url && res.url !== u.toString() ? `\n最终 URL：${res.url}` : "";
      return {
        ok: false,
        error:
          `详情页返回内容异常（过大）：净内容 ${slim.length} 字符（上限 ${FETCH_HTML_MAX_CHARS}）` +
          (title ? `\n返回页面标题：${title}` : "") +
          finalUrl,
      };
    }
    return { ok: true, html: slim };
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || err.code === 20);
    return { ok: false, error: aborted ? "详情页抓取超时" : `详情页抓取失败：${(err && err.message) || err}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 自动跟进：把用户已确认的一条消息交给招聘站页面的 followup-send.js ----
//
// 边界：一次点击只发一条。这里的重试只针对「消息送不到内容脚本」（刚开的 tab /
// 扩展刚重载），一旦送达就不再发第二次——发送本身绝不重试。结果原样回 web
// （sent / uncertain / failed + 原因码），记录与「对方未读」由 web 侧决定。

const FOLLOWUP_CONTENT_RETRY = 3;
const FOLLOWUP_CONTENT_RETRY_MS = 700;

/** URL → 比较键（origin + 去尾斜杠的路径）；非法 URL 返回 null。 */
function urlMatchKey(raw) {
  try {
    const u = new URL(raw);
    return { origin: u.origin, path: u.pathname.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

/** 找已开的同职位页（同 origin，路径相同或互为前缀）。 */
async function findFollowupTab(raw) {
  const key = urlMatchKey(raw);
  if (!key) return null;
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const hits = tabs.filter((tab) => {
    if (!tab.url) return false;
    const k = urlMatchKey(tab.url);
    if (!k || k.origin !== key.origin) return false;
    return k.path === key.path || k.path.startsWith(`${key.path}/`) || key.path.startsWith(`${k.path}/`);
  });
  if (!hits.length) return null;
  return hits.find((tab) => tab.active) || hits[0];
}

/** 没开就新开并等加载；content script 在 document_idle 注入，多留 800ms。 */
async function openFollowupTab(raw) {
  const tab = await chrome.tabs.create({ url: raw, active: true });
  await waitTabLoaded(tab.id, 15000);
  await new Promise((resolve) => setTimeout(resolve, 800));
  return tab;
}

async function sendFollowup(msg) {
  const url = typeof (msg && msg.url) === "string" ? msg.url.trim() : "";
  const text = typeof (msg && msg.text) === "string" ? msg.text : "";
  if (!/^https?:\/\//i.test(url)) return { ok: false, status: "failed", reason: "no-url" };
  if (!text.trim()) return { ok: false, status: "failed", reason: "empty-text" };

  // 页面已开 → 提到前台（用户要能看见填了什么、发出去了什么）；没开 → 新开。
  let tab = await findFollowupTab(url);
  if (tab && typeof tab.id === "number") {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (typeof tab.windowId === "number") await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else {
    tab = await openFollowupTab(url);
  }
  if (!tab || typeof tab.id !== "number") return { ok: false, status: "failed", reason: "no-tab" };

  let lastError = null;
  // 「点过继续沟通」这件事必须由 SW 记住：点完页面就跳走，旧文档里的脚本随之
  // 销毁，新文档不知道自己是怎么进来的。这里等页面加载完，把标志带给下一次。
  let entryClicked = false;
  let jobContact = "";
  for (let attempt = 0; attempt < FOLLOWUP_CONTENT_RETRY; attempt += 1) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "followup-send", text, entryClicked, jobContact });
      if (res && res.status === "navigating") {
        // 上一次一个字都没写，只是点了入口：等聊天页加载完再来一次，不算发送重试。
        // 岗位页上读到的招聘者姓名一起带过去，聊天窗读不到名字时用它兜。
        jobContact = typeof res.entryContact === "string" ? res.entryContact : "";
        await waitTabLoaded(tab.id, 8000);
        await new Promise((resolve) => setTimeout(resolve, 800));
        entryClicked = true;
        continue;
      }
      if (res && typeof res === "object") return { ...res, tabId: tab.id };
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, FOLLOWUP_CONTENT_RETRY_MS));
    }
  }
  return {
    ok: false,
    status: "failed",
    reason: "no-content-script",
    detail: (lastError && lastError.message) || null,
    tabId: tab.id,
  };
}

// ---- message routing ------------------------------------------------------

const selectionByTab = new Map(); // tabId → string[] (selected posting URLs)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "get-state": {
        if (msg && msg.force) invalidatePort();
        const port = await ensureLivePort().catch(() => null);
        // reason 只在未连通时有意义：timeout=服务在忙 / refused=没起服务 / http|invalid=端口上是别的服务。
        // popup 靠它把「未检测到本地 web 服务」拆成两句话（否则用户会去重启一个根本没停的服务）。
        sendResponse({
          ok: true,
          connected: port != null,
          port,
          reason: port == null ? lastProbe.reason : null,
          timeoutMs: PROBE.PROBE_TIMEOUT_MS,
        });
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
          // 单值版本错误已退役：它会被最后 settle 的端口覆盖。改成「3000 一句结论
          // + 逐端口明细表」，下次一眼看出是超时、拒连还是端口上坐着别的服务。
          versionErr: lastProbe.reason ? `${PRIMARY_PORT}:${lastProbe.reason}` : null,
          probeDiag: lastProbe.table,
          probeAt: lastProbe.at || null,
          probeTimeoutMs: PROBE.PROBE_TIMEOUT_MS,
          // 超时那一瞬的在飞本地请求数 + 常驻的共享事件通道状态。这是区分
          // 「服务端慢」与「扩展把同源 6 条连接占满」的唯一现场证据。
          probeInflight: lastProbe.inflight || 0,
          probeInflightNow: inflightLocal,
          eventsChannel: eventsChannel ? { attempt: eventsChannel.attempt, subscribers: runEvents.subscribers() } : null,
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
          const result = await resolveReportJump(msg, sender);
          sendResponse(result);
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case "open-web": {
        // 浮窗标题栏 🌐 的面板级 Web 端入口（ADR-0078 修订）：主落点 = 当前职位的
        // 报告页（msg.num 来自浮窗的已评估行，与徽章/行级链路同一来源）；未评估
        // （无报告号）时兜底进 /pipeline 收件箱——面板级入口在任何状态下都得有去处。
        // 两条支路与 open-report 走同一套解析口径（collectWebTabContext + 纯层）。
        // 端口探测失败报错不跳转：把一个已经连不上的页面推到用户面前，比直说
        // 「web 服务没跑」更困惑（ADR-0055 决策 8 同款语义）。
        try {
          const num = Number(msg.num);
          if (Number.isFinite(num) && num > 0) {
            const result = await resolveReportJump({ ...msg, kind: "report" }, sender);
            sendResponse({ ...result, webUrl: result.reportUrl });
            break;
          }
          const port = await ensureLivePort().catch(() => null);
          const { tabs, currentWindowId } = await collectWebTabContext(sender);
          const target = REPORT_TARGET.pickWebTarget({ livePort: port, tabs, currentWindowId });
          if (target.action === "error") {
            sendResponse({ ok: false, error: target.error });
            break;
          }
          if (target.action === "create") {
            // 服务活着但没有任何 web 端标签页：新开一个，别让用户点不动。
            await chrome.tabs.create({ url: target.url });
            sendResponse({ ok: true, webUrl: target.url, mode: "created" });
            break;
          }
          // /pipeline 是应用路由，永远走前端路由优先（无 ack 回退整页导航）。
          const mode = await revealWebTab(target, false);
          sendResponse({ ok: true, webUrl: target.url, mode });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case "get-active-runs": {
        // 列表卡轮询这一条判断「本卡是不是正在评估 / 在排队」（2s 缓存，见上方注释）。
        // 服务没起时回 ok:false 但空数组 —— content script 据此把临时态胶囊全部收掉，
        // 不会因为读不到任务列表就把旧状态一直贴在那儿。
        sendResponse(await loadActiveRuns());
        break;
      }
      case "open-job": {
        // 「评估中 / 排队中」胶囊可点：跳 web 端工作器里对应的那条任务。
        try {
          sendResponse(await resolveJobJump(msg, sender));
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case "followup-send": {
        // 跟进页「自动跟进」的发送通道：web 面板把确认过的文本交来，本 SW 负责
        // 定位/打开职位页并转发给 followup-send.js，结果原样回传（含失败原因码）。
        try {
          sendResponse(await sendFollowup(msg));
        } catch (err) {
          sendResponse({ ok: false, status: "failed", reason: "exception", detail: (err && err.message) || String(err) });
        }
        break;
      }
      case "set-status": {
        // 列表卡状态胶囊的写回通道：/api/status 只认 tracker 行号 n，content script
        // 因混合内容不能直连本机服务，统一经这里转发（同 quick-evaluate 的口径）。
        try {
          const n = msg && msg.n != null ? String(msg.n).trim() : "";
          const status = typeof msg.status === "string" ? msg.status.trim() : "";
          if (!n || !status) {
            sendResponse({ ok: false, error: "n and status required" });
            break;
          }
          const base = `http://127.0.0.1:${await ensureLivePort()}`;
          const res = await localFetch(`${base}/api/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ n, status }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || !body || body.ok !== true) {
            // 服务端错误串是可操作中文（状态非法 / 行不存在 / 锁被占用），原样透出。
            sendResponse({ ok: false, error: (body && body.error) || `状态更新失败（HTTP ${res.status}）` });
            break;
          }
          const canon = typeof body.status === "string" ? body.status : status;
          // 本地索引立即同步：reportNum 就是 tracker 行号，不必等下一次整表重拉。
          for (const key of Object.keys(evaluated)) {
            const entry = evaluated[key];
            if (entry && String(entry.reportNum) === n) entry.status = canon;
          }
          sendResponse({ ok: true, status: canon });
          notifyContentScripts(); // 其他标签页同步；页面已乐观更新，不阻塞本次写入
        } catch (err) {
          sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
        break;
      }
      case "fetch-detail-html": {
        // 站点侧被 CORS 挡住的详情页由 SW 代抓（智联跨子域），解析仍在 content script。
        sendResponse(await fetchDetailHtml(msg && msg.url));
        break;
      }
      case "fetch-report-content": {
        // 页内阅读弹窗的正文来源（ADR-0074）。招聘站页面是 https，在它里面直接
        // fetch http://localhost 会被混合内容规则拦掉（不是 CORS 问题，绕不过）；
        // service worker 有 host_permissions，由它代发再把文本回给 content script。
        // 这里只当搬运工：报告 markdown / 体检 HTML 都原样透传，渲染口径在 content
        // script 一侧（markdown 先转义再上标记，HTML 进 sandbox iframe）。超时必须有：
        // 开发服务器挂住时没有超时 = 弹窗永远停在「加载中」，比报错更让用户以为坏了。
        const num = String(msg.num == null ? "" : msg.num).replace(/[^0-9]/g, "");
        if (!num) {
          sendResponse({ ok: false, error: "无效报告号" });
          break;
        }
        const apiPath = msg.kind === "checkup" ? REPORT_TARGET.checkupPath(num) : `/api/report-source?n=${num}`;
        try {
          const port = await ensureLivePort().catch(() => null);
          if (port == null) {
            sendResponse({ ok: false, error: REPORT_TARGET.NO_SERVICE_ERROR });
            break;
          }
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), FETCH_CONTENT_TIMEOUT_MS);
          let res;
          let text;
          try {
            res = await fetch(`http://127.0.0.1:${port}${apiPath}`, { signal: ctrl.signal });
            // 读体也必须在超时保护里：开发服务器可能头已发出、正文卡住不写完，那时
            // 早一步 clearTimeout 等于没有超时，弹窗永远停在「加载中」。
            text = await res.text();
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) {
            // 404 = 这一号没有可读的报告文件；其余状态一律当作读不出来报给用户。
            sendResponse({ ok: false, error: `本地报告读不出来（${res.status}）` });
            break;
          }
          sendResponse({ ok: true, text, kind: msg.kind === "checkup" ? "checkup" : "report" });
        } catch (err) {
          sendResponse({ ok: false, error: `本地报告取正文失败：${(err && err.message) || err}` });
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
        // 内联 JD/雇主名/职位标题(详情页 DOM 提取,猎聘等登录墙站点绕开服务端抓取)。
        // role 只用于服务端任务卡标题——被门禁拦下的评估没有报告可回填职位名。
        const jdText = typeof msg.jdText === "string" && msg.jdText.trim() ? msg.jdText.trim() : "";
        const company = typeof msg.company === "string" && msg.company.trim() ? msg.company.trim() : "";
        const role = typeof msg.role === "string" && msg.role.trim() ? msg.role.trim() : "";
        (async () => {
          const base = `http://127.0.0.1:${await ensureLivePort()}`;
          const cfg = await resolveEvalConfig(base);
          const cliId = msg.cliId || cfg.cliId;
          const model = msg.model || cfg.model || null;
          if ((await probeEvalRoute(base)) === "run") {
            await runSingleViaApi({ base, url, cliId, model, jdText, company, role, tabId });
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
                await chrome.tabs.sendMessage(tabId, { type: "single-eval-error", url, error: err.message });
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
            chrome.tabs.sendMessage(tabId, { type: "single-eval-error", url, error: err instanceof Error ? err.message : String(err) }).catch(() => {});
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
          // 快评最长占 18s 一条连接，也是同源 6 条池子的常客 —— 计入在飞数
          // （否则超时诊断里看不到它，只会看到「服务在忙」这种误导性结论）。
          let qres;
          let j = {};
          enterLocal();
          try {
            qres = await fetch(`${base}/api/quick-eval`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: typeof msg.url === "string" ? msg.url : "",
                title: typeof msg.title === "string" ? msg.title : "",
                text,
              }),
              // 外层预算必须大于服务端内层 QUICK_EVAL_TIMEOUT_MS（15s），好让内层先超时、
              // 回一个可读的「快评超时…」文案；若外层先 abort，只会落到下方 catch 的笼统提示。
              // 18s < route maxDuration 60s。
              signal: AbortSignal.timeout(18000),
            });
            j = await qres.json().catch(() => ({}));
          } finally {
            // 正文读完才算这条连接用完了 —— 计数放得太早会让诊断低估占用。
            exitLocal();
          }
          if (!qres.ok) {
            const notice =
              j && j.error === "quickEvalNotConfigured"
                ? "快评不可用：未配置 AI 密钥（设置页 → 粘贴 AI 密钥）"
                : "快评失败：" + ((j && j.error) || `HTTP ${qres.status}`);
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
          runWrapUp({ drives: driveSnapshots(), scanId: endedScanId, exploreTabId });
        }
        break;
      }
      default:
        // 带上 code：content script 侧要靠它识别「页面注入的是新代码、SW 还是重载前的
        // 旧代码」这种版本错配，并翻成可操作提示（detail-panel-pure.js 的
        // readerErrorText）。英文散文是通用兜底措辞，改动不该让那条提示退化。
        sendResponse({ ok: false, error: "unknown message type", code: "unknown-message-type" });
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
 * 单职位评估的单任务链路：POST /api/run 拿 runId → 在全 SW 共用的那条 /api/events
 * 通道上按 runId 订阅（总线多路复用，见 subscribeRunEvents）。
 *
 * 对详情页而言这与批量路无差异：收尾靠 evaluated-updated 与 3s 轮询，失败靠
 * `single-eval-error`。popup 也只认它已有的 stage 形状（事件由纯函数折叠而来）。
 */
async function runSingleViaApi({ base, url, cliId, model, jdText, company, role, tabId }) {
  announce({ stage: "start", total: 1, url });
  const failToTab = (message) => {
    announce({ stage: "error", error: message });
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: "single-eval-error", url, error: message }).catch(() => {});
    }
  };
  // SW 保活：读流不算活动事件，空闲 30s 就被 Chrome 终止（同 runBatch 里那段教训）。
  const keepalive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  let state = SINGLE.createRunState(url);
  let unsubscribe = null;
  try {
    // 派发只建 run 拿 runId，正常毫秒级；单给它一个超时，别让「派发卡住」长期占着
    // 同源连接。run 的事件走全 SW 共用的那条通道（不再每次评估各开一条 /api/events）。
    const res = await localFetch(`${base}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "evaluate",
        input: url,
        cliId,
        model: model || undefined,
        // 内联 JD/雇主名/职位标题（详情页 DOM 提取）：登录墙站靠它绕开服务端抓取；
        // role 只用于任务卡标题，老服务不认这个字段也无碍。
        jdText: jdText || undefined,
        company: company || undefined,
        role: role || undefined,
      }),
      timeoutMs: 30000,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j || !j.runId) throw new Error((j && j.error) || `评估接口返回 ${res.status}`);
    const runId = j.runId;
    // 先订阅再等：subscribe 会把「POST 返回到订阅之间」已到达的帧回放出来
    // （总线按 runId 缓冲），所以不存在丢首帧的窗口。
    const finished = new Promise((resolve, reject) => {
      unsubscribe = subscribeRunEvents(base, runId, (frame) => {
        // 通道级故障（重连耗尽）：评估本身可能还在后台跑，但要先告诉页面。
        if (frame && frame.error) {
          reject(new Error(frame.error));
          return;
        }
        if (!frame || !frame.ev) return;
        const step = SINGLE.consumeRunEvent(state, frame.ev);
        state = step.state;
        for (const ev of step.events) announce(ev);
        if (state.finished) resolve();
      });
    });
    await finished;
    await loadEvaluated(base);
    await notifyContentScripts();
    // 评估结束：服务必然在线，强制刷新徽章（绕过节流，纠正评估期间的任何陈旧态）。
    await updateBadge(true).catch(() => {});
  } catch (err) {
    if (!state.finished) failToTab(err instanceof Error ? err.message : String(err));
  } finally {
    // 只退订自己这一路 —— 共享通道要保持（其他评估还在用它）。
    if (unsubscribe) unsubscribe();
    clearInterval(keepalive);
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
    // 批量 NDJSON 是另一条长连接（时长由评估本身决定），同样计入在飞数：
    // 它和共享事件通道各占一条，同源池 6 条里这两条是长期住户。
    enterLocal();
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
    exitLocal();
  }
}