"use strict";

// 托盘面板的渲染层（工单 04）。零网络、零 fs：只消费主进程推来的快照。
// 视觉照搬 .scratch/tray-flyout/prototype.html；这里是数据绑定与状态文案。

const PIPE = [
  { k: "applied", label: "投递中" },
  { k: "responded", label: "有回应" },
  { k: "interview", label: "面试中" },
  { k: "offer", label: "Offer" },
];

const STATE_UI = {
  run: { pill: ["run", "运行中"], state: "已就绪", cls: "run", dot: "run" },
  starting: { pill: ["start", "启动中"], state: "正在启动", cls: "start", dot: "start" },
  down: { pill: ["idle", "已停止"], state: "已停止", cls: "", dot: "" },
  failed: { pill: ["down", "启动失败"], state: "未就绪", cls: "down", dot: "down" },
};

const CHART = { W: 320, baseY: 62, maxH: 40, labelY: 80, barW: 36, minBar: 6 };

const el = (id) => document.getElementById(id);
const flyoutEl = el("flyout");
let lastHeight = 0;

// 直接双击 panel.html 做设计核对时的占位快照（生产面板由主进程推第一帧覆盖）。
const DEMO = {
  theme: "auto",
  service: {
    state: "run",
    ready: true,
    starting: false,
    failed: false,
    owned: false,
    pid: 8821,
    since: Date.now() - 4320000,
    healthMs: 38,
    coreVersion: "2.41.0",
    sha: "05174d5",
    packaged: false,
  },
  pipeline: { applied: 64, responded: 12, interview: 4, offer: 1, total: 128 },
  followups: {
    due: 3,
    items: [
      { company: "Acme", role: "Staff Engineer", urgency: "overdue" },
      { company: "Globex", role: "AI PM", urgency: "urgent" },
      { company: "Initech", role: "Backend Lead", urgency: "overdue" },
    ],
  },
  runs: { running: 2, queued: 1 },
};

function markSvg(size) {
  const w = 4.2;
  const gap = 3;
  const total = w * 3 + gap * 2;
  const x0 = (size - total) / 2;
  const base = size - 7;
  const heights = [7, 11.5, 16];
  let bars = "";
  const tops = [];
  heights.forEach((h, i) => {
    const x = x0 + i * (w + gap);
    bars += `<rect x="${x.toFixed(2)}" y="${(base - h).toFixed(2)}" width="${w}" height="${h}" rx="1.1" fill="#fff"/>`;
    tops.push([x + w / 2, base - h]);
  });
  const points = tops.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <rect width="${size}" height="${size}" rx="8" fill="var(--brand)"/>${bars}
    <polyline points="${points}" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${tops[2][0].toFixed(2)}" cy="${tops[2][1].toFixed(2)}" r="1.7" fill="#fff"/>
  </svg>`;
}

/**
 * 柱高 = log10(1+n)/log10(1+max) × 最大高，最低 6px 的基线桩。
 * 线性缩放会让 1 条彻底消失，对数让漏斗形状可读；全 0 时四柱等高基线（不许整块消失）。
 */
function barHeight(n, max) {
  if (!(max > 0)) return CHART.minBar;
  return Math.max(CHART.minBar, (Math.log10(1 + n) / Math.log10(1 + max)) * CHART.maxH);
}

function renderChart(pipeline) {
  const chart = el("chart");
  const colW = CHART.W / 4;
  const values = PIPE.map((p) => (pipeline ? Number(pipeline[p.k]) || 0 : 0));
  const max = Math.max(...values, 0);
  const empty = !pipeline;

  const geo = PIPE.map((p, i) => {
    const h = barHeight(values[i], max);
    return { ...p, n: values[i], cx: colW * i + colW / 2, h, y: CHART.baseY - h };
  });

  const bars = geo
    .map(
      (g) => `
    <g class="bar" data-k="${g.k}" data-n="${g.n}" tabindex="0" role="button"
       aria-label="${g.label} ${empty ? "数据不可用" : `${g.n} 条`}，打开仪表盘筛选">
      <rect class="bar-rect" x="${(g.cx - CHART.barW / 2).toFixed(1)}" y="${g.y.toFixed(1)}"
            width="${CHART.barW}" height="${g.h.toFixed(1)}" rx="4"/>
      <rect x="${(g.cx - colW / 2).toFixed(1)}" y="0" width="${colW}" height="84" fill="transparent"/>
    </g>`,
    )
    .join("");

  const nums = geo
    .map(
      (g) =>
        `<text class="chart-num" x="${g.cx}" y="${Math.max(11, g.y - 7).toFixed(1)}" text-anchor="middle">${empty ? "—" : g.n}</text>`,
    )
    .join("");
  const labels = geo
    .map((g) => `<text class="chart-label" x="${g.cx}" y="${CHART.labelY}" text-anchor="middle">${g.label}</text>`)
    .join("");

  chart.dataset.empty = String(empty);
  chart.innerHTML = `<svg viewBox="0 0 ${CHART.W} 84" role="group" aria-label="管道分布">
    <line class="baseline" x1="0" y1="${CHART.baseY}" x2="${CHART.W}" y2="${CHART.baseY}"/>
    ${bars}${nums}${labels}
  </svg>`;

  for (const bar of chart.querySelectorAll(".bar")) {
    const go = () => window.tray?.openTab(bar.dataset.k);
    bar.addEventListener("click", go);
    bar.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        go();
      }
    });
  }

  el("total").textContent = pipeline ? `${pipeline.total} 条在册` : "—";
}

function urgencyLabel(urgency) {
  const key = String(urgency || "").toLowerCase();
  if (key === "overdue") return "逾期";
  if (key === "urgent") return "紧急";
  if (key === "waiting") return "等待";
  if (key === "cold") return "冷淡";
  return key || "待办";
}

function renderFollowups(followups) {
  const list = el("todoList");
  list.textContent = "";

  const items = followups ? followups.items || [] : [];
  el("todoCount").textContent = followups ? `${followups.due} 项到期` : "—";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "todo-empty";
    empty.textContent = followups ? "没有到期跟进" : "跟进数据不可用";
    list.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "todo-row";
    row.setAttribute("aria-label", `${item.company}${item.role ? " · " + item.role : ""}，打开跟进页`);

    const dot = document.createElement("span");
    dot.className = "todo-dot";
    dot.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = item.role ? `${item.company} · ${item.role}` : item.company;

    const urg = document.createElement("span");
    const hot = /overdue|urgent/i.test(String(item.urgency || ""));
    urg.className = hot ? "todo-urg hot" : "todo-urg";
    urg.textContent = urgencyLabel(item.urgency);

    const arrow = document.createElement("span");
    arrow.className = "todo-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

    row.append(dot, text, urg, arrow);
    row.addEventListener("click", () => window.tray?.openTab("followups"));
    list.appendChild(row);
  }
}

function renderRuns(runs) {
  const node = el("runs");
  if (!runs) {
    node.textContent = "—";
    return;
  }
  if (runs.running === 0 && runs.queued === 0) {
    node.textContent = "空闲";
    return;
  }
  node.innerHTML = `<b>${runs.running}</b> 在跑${runs.queued > 0 ? ` · <b>${runs.queued}</b> 排队` : ""}`;
}

function uptimeLabel(since) {
  if (!since) return "";
  const minutes = Math.max(0, Math.round((Date.now() - since) / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function serviceMeta(service) {
  switch (service.state) {
    case "run": {
      const parts = [];
      if (typeof service.healthMs === "number") parts.push(`健康 ${service.healthMs} ms`);
      if (service.pid) parts.push(`pid ${service.pid}`);
      // 外部实例的「运行时长」我们是不知道的（它是别人起的），不编一个数字出来。
      if (service.owned && service.since) parts.push(`已运行 ${uptimeLabel(service.since)}`);
      return { text: parts.join(" · ") || "已就绪", bad: false };
    }
    case "starting":
      return { text: "等待 3000 端口应答", bad: false };
    case "failed":
      return { text: (service.failReason || "启动失败").split("\n")[0], bad: true };
    default:
      return { text: "端口 3000 空闲 · 无服务进程", bad: false };
  }
}

function renderService(service) {
  const ui = STATE_UI[service.state] || STATE_UI.down;
  const external = service.state === "run" && service.owned === false;

  const pill = el("pill");
  pill.className = `pill ${ui.pill[0]}`;
  pill.textContent = ui.pill[1];

  el("svcDot").className = `dot ${ui.dot}`;
  const stateNode = el("svcState");
  stateNode.className = `svc-state ${ui.cls}`;
  stateNode.textContent = ui.state;

  const meta = serviceMeta(service);
  const metaNode = el("svcMeta");
  metaNode.className = meta.bad ? "svc-meta bad" : "svc-meta";
  metaNode.textContent = meta.text;

  el("svcChip").hidden = !external;

  const blocked = service.state === "starting" || external;
  el("rowRestart").disabled = blocked;
  el("rowRestart").title = external ? "外部实例不受本壳管理" : "重启服务";
  el("rowRestart").setAttribute("aria-label", el("rowRestart").title);

  const primary = el("openBtn");
  primary.disabled = service.state === "starting";
  primary.textContent =
    service.state === "run" ? "打开仪表盘" : service.state === "starting" ? "启动中…" : service.state === "failed" ? "重新启动" : "启动服务";

  const ghost = el("restartBtn");
  ghost.hidden = service.state === "down" || service.state === "failed";
  ghost.disabled = blocked;
}

function renderVersion(service) {
  const node = el("version");
  const core = service.coreVersion || service.version || "";
  const sha = service.sha || "";
  const label = core ? `v${core}${sha ? ` · ${sha}` : ""}` : sha || "—";
  node.textContent = label;
  // 连版本号都没拿到（服务起不来时就是这样）就别再挂个 dev 尾巴，否则读成「—dev」。
  if (!service.packaged && label !== "—") {
    const tag = document.createElement("span");
    tag.className = "devtag";
    tag.textContent = "dev";
    node.appendChild(tag);
  }
}

function render(snapshot) {
  if (!snapshot || !snapshot.service) return;
  document.documentElement.dataset.theme = snapshot.theme === "dark" ? "dark" : "light";
  renderChart(snapshot.pipeline);
  renderFollowups(snapshot.followups);
  renderRuns(snapshot.runs);
  renderService(snapshot.service);
  renderVersion(snapshot.service);
  el("fsub").textContent = "localhost:3000";
  requestAnimationFrame(fit);
}

/** 内容高度上报（夹在 240–820 由主进程做），面板高度贴内容、不出现滚动条。 */
function fit() {
  const height = Math.ceil(flyoutEl.offsetHeight) + 20; // body 上下各 10px 的阴影留白
  if (height === lastHeight) return;
  lastHeight = height;
  window.tray?.fit(height);
}

// ---------------- 交互 ----------------

function bindActions() {
  el("openBtn").addEventListener("click", async () => {
    const button = el("openBtn");
    if (button.disabled) return;
    if (button.textContent === "打开仪表盘") {
      await window.tray?.openDashboard();
      return;
    }
    await window.tray?.restart();
  });

  el("restartBtn").addEventListener("click", () => window.tray?.restart());
  el("rowRestart").addEventListener("click", () => window.tray?.restart());
  el("rowLogs").addEventListener("click", () => window.tray?.showLogs());
  el("logBtn").addEventListener("click", () => window.tray?.showLogs());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.tray?.hide();
  });
}

async function boot() {
  el("mark").innerHTML = markSvg(30);
  bindActions();

  if (!window.tray) {
    // 设计核对路径（浏览器直接打开 panel.html）：用占位快照渲染一帧。
    render(DEMO);
    return;
  }

  window.tray.onSnapshot(render);
  const snapshot = await window.tray.snapshot();
  render(snapshot || DEMO);
}

boot();
