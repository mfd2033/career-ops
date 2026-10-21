"use strict";

// 日志窗口（工单 03）：读主进程的环形缓冲 + 每秒增量续读。
// 渲染层不碰文件（没有 fs 权限），文件成长由主进程的 logger 负责落盘。

const view = document.getElementById("view");
const pathNode = document.getElementById("path");
const hint = document.getElementById("hint");
const followBtn = document.getElementById("follow");

const POLL_MS = 1000;
const ERROR_RE = /失败|错误|error|failed|exception|崩溃/i;

let lastSeq = 0;
let following = true;
let timer = null;

function lineNode(entry) {
  const row = document.createElement("div");
  row.className = "line";
  row.dataset.source = entry.source === "server" ? "server" : "launcher";
  if (ERROR_RE.test(entry.text || "")) row.dataset.level = "error";

  const t = document.createElement("span");
  t.className = "t";
  t.textContent = entry.t;

  const src = document.createElement("span");
  src.className = "src";
  src.textContent = entry.source;

  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = entry.text;

  row.append(t, src, msg);
  return row;
}

function atBottom() {
  return view.scrollHeight - view.scrollTop - view.clientHeight <= 8;
}

function setFollowing(value) {
  following = value;
  followBtn.setAttribute("aria-pressed", String(value));
}

function scrollToEnd() {
  view.scrollTop = view.scrollHeight;
}

/** 追加一批日志；`cleared` 标记来自「清屏」，在这里把视图也清掉。 */
function append(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  let appended = false;
  for (const entry of entries) {
    lastSeq = Math.max(lastSeq, entry.seq || lastSeq);
    if (entry.cleared) {
      view.textContent = "";
      appended = false;
      continue;
    }
    view.appendChild(lineNode(entry));
    appended = true;
  }
  if (appended && following) scrollToEnd();
}

async function poll() {
  try {
    append(await window.logs.tail(lastSeq));
  } catch {
    /* 主进程正在退出：下一轮自然停 */
  }
}

async function boot() {
  const snapshot = await window.logs.snapshot();
  pathNode.textContent = snapshot.path || "—";
  pathNode.title = snapshot.path || "";
  hint.hidden = snapshot.fileOk !== false;

  // 环形缓冲里可能已经有过一次「清屏」：只渲染它之后的，避免把清掉的行又吐回来。
  const entries = snapshot.entries || [];
  const lastClear = entries.map((e) => (e.cleared ? e.seq : 0)).reduce((a, b) => Math.max(a, b), 0);
  const visible = entries.filter((entry) => entry.seq > lastClear);
  lastSeq = lastClear;
  append(visible);
  scrollToEnd();

  timer = setInterval(poll, POLL_MS);
}

followBtn.addEventListener("click", () => {
  setFollowing(!following);
  if (following) scrollToEnd();
});

view.addEventListener("scroll", () => {
  // 用户往上滚 = 不想被拽回底部；滚到底自动恢复跟随。
  if (atBottom() && !following) setFollowing(true);
  else if (!atBottom() && following) setFollowing(false);
});

document.getElementById("clear").addEventListener("click", async () => {
  view.textContent = "";
  const result = await window.logs.clear();
  lastSeq = Math.max(lastSeq, result?.seq || 0);
});

document.getElementById("folder").addEventListener("click", () => window.logs.openFolder());

document.getElementById("close").addEventListener("click", () => window.close());

window.addEventListener("beforeunload", () => clearInterval(timer));

boot();
