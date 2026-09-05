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
const PROBE_TIMEOUT_MS = 900;

let cachedPort = null;
let probing = null;

// Latest DOM diagnostics reported by the content script (for the popup's
// debug box, since BOSS blocks DevTools by resizing/kicking the page).
let lastContentDiag = null;

async function versionOk(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/version`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const j = await res.json();
    return !!(j && j.version);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Yes the first live port in 3000-3040 (all probed concurrently, first ok wins). */
function probePort() {
  if (cachedPort) return Promise.resolve(cachedPort);
  if (probing) return probing;
  const attempts = [];
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    attempts.push(versionOk(`http://localhost:${port}`).then((ok) => (ok ? port : null)));
  }
  probing = Promise.all(attempts).then((found) => {
    probing = null;
    cachedPort = found.find((p) => p != null) ?? null;
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
  if (port == null) throw new Error("本地 web 服务未运行（扫描 localhost:3000-3040 未命中）");
  return port;
}

/**
 * Port guaranteed live right now: verify the cached port first (it may have
 * gone away since it was probed), else re-probe. Prevents clicking an evaluated
 * badge from opening a dead localhost link when the dashboard restarted.
 */
async function ensureLivePort() {
  console.log("[bg] ensureLivePort cachedPort=", cachedPort);
  if (cachedPort && (await versionOk(`http://localhost:${cachedPort}`))) {
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
  try {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    if (cfg && typeof cfg.cliId === "string" && cfg.cliId) cliId = cfg.cliId;
    if (cfg && typeof cfg.model === "string" && cfg.model) model = cfg.model;
  } catch {
    /* server config missing — fall back below */
  }
  if (!cliId) {
    try {
      const d = await (await fetch(`${base}/api/clis`)).json();
      const installed = (d && d.clis ? d.clis : []).filter((c) => c.installed);
      if (installed.length === 1) cliId = installed[0].id;
    } catch {
      /* no CLIs readable */
    }
  }
  return { cliId, model };
}

// ---- evaluated map --------------------------------------------------------

// normalizedUrl → { score, reportNum }; refreshed from /api/report-status.
let evaluated = {};

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
        const map = await loadEvaluated(`http://localhost:${port}`);
        sendResponse({ ok: true, connected: true, port, map, keys: Object.keys(map).length });
        break;
      }
      case "get-diagnostics": {
        const port = await ensureLivePort().catch(() => null);
        sendResponse({
          ok: true,
          connected: port != null,
          port,
          cachedPort,
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
          await chrome.tabs.create({ url: `http://localhost:${port}/report/${num}` });
          sendResponse({ ok: true, reportUrl: `http://localhost:${port}/report/${num}` });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }
      case "refresh-evaluated": {
        try {
          const port = await ensureLivePort();
          await loadEvaluated(`http://localhost:${port}`);
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
        runBatch([url], msg.cliId, msg.model).catch((err) =>
          announce({ stage: "error", error: err.message }),
        );
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })();
  return true; // async sendResponse
});

/** Tell every zhipin tab to re-fetch the evaluated map and re-render badges. */
async function notifyContentScripts() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    if (tab.url && /^https?:\/\/([^/]*\.)?zhipin\.com\//.test(tab.url)) {
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
async function runBatch(urls, cliId, model) {
  if (!Array.isArray(urls) || urls.length === 0) {
    announce({ stage: "error", error: "没有可评估的职位" });
    return;
  }
  const base = `http://localhost:${await ensureLivePort()}`;

  const cfg = await resolveEvalConfig(base);
  const body = { urls, cliId: cliId || cfg.cliId, model: model || cfg.model || null };

  announce({ stage: "start", total: urls.length });
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
}