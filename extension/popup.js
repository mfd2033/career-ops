// popup — connection state, batch selection, live NDJSON progress.
"use strict";

const $ = (sel) => document.querySelector(sel);

const stateEl = $("#state");
const reprobeBtn = $("#reprobe");
const selectionEl = $("#selection");
const selCountEl = $("#selCount");
const evaluateBtn = $("#evaluateBtn");
const progressEl = $("#progress");
const progressListEl = $("#progressList");
const progressSummaryEl = $("#progressSummary");
const footTipEl = $("#footTip");

let activeTabId = null;
let worker = null; // chrome.runtime.connect({name:"eval"})
const items = new Map(); // url → {status:"pending"|"running"|"done"|"failed", score}

function msg(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab && typeof tab.id === "number" ? tab.id : null;

  const s = await msg("get-state");
  if (s.ok && s.connected && s.port) {
    stateEl.textContent = `已连接 localhost:${s.port}`;
    stateEl.className = "state connected";
    reprobeBtn.hidden = true;
    await paintSelection();
    footTipEl.textContent = `本地 web：localhost:${s.port}`;
  } else {
    stateEl.textContent = "未检测到本地 web 服务";
    stateEl.className = "state disconnected";
    reprobeBtn.hidden = false;
    selectionEl.hidden = true;
    footTipEl.textContent = "请先启动 career-dashboard";
  }
}

async function paintSelection() {
  if (activeTabId == null) {
    selectionEl.hidden = true;
    return;
  }
  const r = await msg("get-selection", { tabId: activeTabId });
  const urls = r.ok && Array.isArray(r.urls) ? r.urls : [];
  const selected = urls.filter((u) => /^https?:\/\//i.test(u));
  if (selected.length === 0) {
    selectionEl.hidden = true;
    return;
  }
  selectionEl.hidden = false;
  selCountEl.textContent = `已选择 ${selected.length} 个职位`;
  evaluateBtn.disabled = false;
  evaluateBtn.dataset.commit = "";
  evaluateBtn.onclick = () => startBatch(selected);
}

function renderItem(url) {
  let li = items.get(url).li;
  if (!li) {
    li = document.createElement("li");
    li.className = "p-state pending";
    const dot = document.createElement("span");
    dot.className = "p-dot";
    const urlEl = document.createElement("span");
    urlEl.className = "p-url";
    urlEl.textContent = shortUrl(url);
    const scoreEl = document.createElement("span");
    scoreEl.className = "p-score";
    li.append(dot, urlEl, scoreEl);
    progressListEl.appendChild(li);
    items.get(url).li = li;
  }
  const st = items.get(url);
  st.li.className = `p-state ${st.status}`;
  st.li.querySelector(".p-score").textContent =
    st.status === "done" ? (st.score != null ? String(st.score) : "完成") : st.status === "failed" ? "失败" : "";
  return st.li;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + u.pathname;
  } catch {
    return url;
  }
}

function startBatch(urls) {
  progressEl.hidden = false;
  progressListEl.innerHTML = "";
  items.clear();
  for (const url of urls) items.set(url, { status: "pending", score: null, li: null });

  evaluateBtn.disabled = true;
  evaluateBtn.textContent = `评估中 ${urls.length} 个…`;

  worker = chrome.runtime.connect({ name: "eval" });
  worker.onMessage.addListener(handleEvalEvent);
  worker.onDisconnect.addListener(() => worker = null);
  worker.postMessage({ type: "batch-evaluate", urls });
  renderAll();
  refreshSummary();
}

function renderAll() {
  for (const url of items.keys()) renderItem(url);
}

function refreshSummary() {
  const total = items.size;
  const done = [...items.values()].filter((i) => i.status === "done").length;
  const failed = [...items.values()].filter((i) => i.status === "failed").length;
  if (total === 0) {
    progressSummaryEl.textContent = "";
    return;
  }
  const running = total - done - failed - [...items.values()].filter((i) => i.status === "pending").length;
  progressSummaryEl.textContent = `${done}/${total} 完成${running ? ` · ${running} 进行中` : ""}${failed ? ` · ${failed} 失败` : ""}`;
}

function handleEvalEvent(ev) {
  if (!ev) return;
  if (ev.stage === "start") {
    // already seeded by startBatch
  } else if (ev.stage === "status" && ev.text) {
    // "[i/N] http://... (report #n)" → mark that url running
    const url = /(https?:\/\/\S+)/.exec(ev.text)?.[1];
    if (url && items.has(url)) {
      items.get(url).status = "running";
      renderItem(url);
    }
  } else if (ev.stage === "item") {
    if (ev.url && items.has(ev.url)) {
      const it = items.get(ev.url);
      it.status = ev.ok ? "done" : "failed";
      it.score = ev.ok && ev.score != null ? ev.score : null;
      renderItem(ev.url);
    }
  } else if (ev.stage === "done") {
    evaluateBtn.disabled = false;
    evaluateBtn.textContent = "评估选中职位";
    progressSummaryEl.textContent = `全部完成：${ev.ok} 成功${ev.failed ? `，${ev.failed} 失败` : ""}`;
    // badges refresh happens in the background; nudge the page too via re-probe of selection
    setTimeout(() => paintSelection(), 0);
  } else if (ev.stage === "error") {
    evaluateBtn.disabled = false;
    evaluateBtn.textContent = "评估选中职位";
    progressSummaryEl.textContent = `评估出错：${ev.error}`;
  }
  refreshSummary();
}

reprobeBtn.addEventListener("click", () => {
  stateEl.textContent = "检测中…";
  stateEl.className = "state probing";
  chrome.runtime.sendMessage({ type: "get-state", force: true }, async (res) => {
    if (!chrome.runtime.lastError && res.ok && res.connected && res.port) {
      stateEl.textContent = `已连接 localhost:${res.port}`;
      stateEl.className = "state connected";
      reprobeBtn.hidden = true;
      footTipEl.textContent = `本地 web：localhost:${res.port}`;
      await paintSelection();
    } else {
      stateEl.textContent = "未检测到本地 web 服务";
      stateEl.className = "state disconnected";
      reprobeBtn.hidden = false;
    }
  });
});

document.addEventListener("DOMContentLoaded", () => init());