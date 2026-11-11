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
const diagEl = $("#diag");
const copyDiagBtn = $("#copyDiag");
const diagOverlay = $("#diagOverlay");
const diagBtn = $("#diagBtn");
const diagCloseBtn = $("#diagClose");
const diagDismissBtn = $("#diagDismiss");

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

/**
 * 连接状态三态落 UI：已连接 / 服务在忙（探测超时）/ 未检测到服务。
 *
 * 三态是这一版的关键：托盘只肯在「连续 30s 答不上」时才报挂，而扩展的探测窗口只有
 * 几秒，两者之间的窗口里服务进程在、端口在听、但事件循环被重路由占住。那个状态下
 * 说「未检测到本地 web 服务」会把用户指向一个根本没停的服务。
 * 徽章仍是二值（ADR-0050 决策：版本校验失败按未连处理），三态只落在 popup 文案上。
 */
async function paintState(s) {
  if (s && s.ok && s.connected && s.port) {
    stateEl.textContent = `已连接 localhost:${s.port}`;
    stateEl.className = "state connected";
    reprobeBtn.hidden = true;
    await paintSelection();
    return;
  }
  reprobeBtn.hidden = false;
  selectionEl.hidden = true;
  if (s && s.ok && s.reason === "timeout") {
    const secs = Math.round((s.timeoutMs || 6000) / 1000);
    stateEl.textContent = "本地服务在忙（探测超时）";
    stateEl.className = "state busy";
    footTipEl.textContent = `服务进程在，但 ${secs} 秒内没答复；稍后点「重新探测」`;
  } else {
    stateEl.textContent = "未检测到本地 web 服务";
    stateEl.className = "state disconnected";
    footTipEl.textContent = "请先启动 career-dashboard";
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab && typeof tab.id === "number" ? tab.id : null;

  await paintState(await msg("get-state"));
  await paintDiag();
}

/** Show background-side state (eval map key count, resolved port) for debugging.
 * 诊断数据只进 lastDiagJson，不再常驻展开；浮层打开时才可见。 */
let lastDiagJson = "";
async function paintDiag() {
  const d = await msg("get-diagnostics");
  const base = {
    connected: d.connected,
    port: d.port,
    cachedPort: d.cachedPort,
    versionErr: d.versionErr,
    evalKeys: d.evalKeys,
  };
  // 逐端口明细：哪一口超时、哪一口拒连、哪一口坐着别的服务，一眼可见。
  if (d.probeDiag) base.probeDiag = d.probeDiag;
  if (d.probeAt) base.probeAt = new Date(d.probeAt).toISOString();
  if (d.contentDiag) base.contentDiag = d.contentDiag;
  lastDiagJson = JSON.stringify(base, null, 2);
  diagEl.textContent = lastDiagJson;
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
    if (chrome.runtime.lastError) {
      await paintState(null);
      return;
    }
    await paintState(res);
    await paintDiag();
  });
});

document.addEventListener("DOMContentLoaded", () => init());

// 诊断浮层开关：打开时先拉一份最新诊断（popup 每次点开都重建，保证 contentDiag 是当前的）
function closeDiag() { diagOverlay.hidden = true; }
diagBtn.addEventListener("click", async () => {
  await paintDiag();
  diagOverlay.hidden = false;
});
diagCloseBtn.addEventListener("click", closeDiag);
diagDismissBtn.addEventListener("click", closeDiag);
diagOverlay.addEventListener("click", (e) => { if (e.target === diagOverlay) closeDiag(); });

// 复制结果反馈必须落在浮层内部：`#footTip` 在主界面 footer 上，而浮层是全屏
// fixed 覆盖，写在 footer 里用户一个字都看不见，于是「点了没反应」。
// 这里把按钮本身切成成功态，2 秒后复位（按钮 flex:1 定宽居中，换字不抖动）。
const COPY_LABEL = "一键复制诊断";
const COPY_FLASH_MS = 2000;
let copyFlashTimer = null;

function flashCopyResult(ok) {
  if (copyFlashTimer) clearTimeout(copyFlashTimer);
  copyDiagBtn.textContent = ok ? "已复制 ✓" : "复制失败";
  copyDiagBtn.classList.toggle("copied", ok);
  copyFlashTimer = setTimeout(() => {
    copyDiagBtn.textContent = COPY_LABEL;
    copyDiagBtn.classList.remove("copied");
    copyFlashTimer = null;
  }, COPY_FLASH_MS);
}

// One-click copy of the last diagnostic snapshot (popup re-opens each click,
// so lastDiagJson may be stale until paintDiag runs; refresh it on demand and
// copy the freshest values).
copyDiagBtn.addEventListener("click", async () => {
  await paintDiag(); // re-pull so contentDiag is current
  try {
    await navigator.clipboard.writeText(lastDiagJson);
    footTipEl.textContent = "诊断已复制 ✓";
    flashCopyResult(true);
  } catch {
    // Clipboard API can be unavailable in some popup contexts; fall back to
    // a select-and-copy of the pre element. `<pre>` 没有 .select()，须先判断，
    // 否则抛 TypeError 变成 unhandled rejection。
    if (typeof diagEl.select === "function") diagEl.select();
    // execCommand 返回布尔值，只有真的复制成功才报成功，否则用户依旧不知道。
    const copied = document.execCommand("copy");
    footTipEl.textContent = copied ? "诊断已复制 ✓" : "复制失败：请手动选中诊断文本复制";
    flashCopyResult(copied);
  }
});