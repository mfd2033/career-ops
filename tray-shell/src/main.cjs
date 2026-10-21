"use strict";

// career-ops 托盘壳的主进程（ADR-0086 / 工单 01–04）。
//
// 职责边界：
//   - 托盘图标 = 品牌标记 + 健康度着色；左键弹无边框 flyout，右键保留原生菜单；
//   - 服务监管（端口 3000、接管链、owned、重启、退出）全在 service.cjs；
//   - 日志契约（同文件、同前缀、启动截断）全在 logger.cjs，日志窗口只是订阅者；
//   - HTTP 只在这里发，渲染层拿 IPC 快照（决策 7）。

const path = require("node:path");
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, screen, shell } = require("electron");

const runtimeModule = require("./runtime.cjs");
const logger = require("./logger.cjs");
const { WEB_PORT, createService } = require("./service.cjs");
const { buildSnapshot, createBusinessFetcher } = require("./snapshot.cjs");
const { trayStateOf, trayTooltip } = require("./state.cjs");
const { drawTrayIcon } = require("./tray-icon.cjs");
const { computeFlyoutPosition } = require("./flyout-position.cjs");

const FLYOUT_WIDTH = 384;
// 透明留白：theme.css 的 body 有 10px padding 用来装 box-shadow。窗口宽 = 卡片 384 + 2×PAD，
// 否则卡片会被裁掉 20px（验收时实测：窗口 384 宽、卡片固定 384，右侧刚好被切）。
const FLYOUT_PAD = 10;
const FLYOUT_WINDOW_WIDTH = FLYOUT_WIDTH + FLYOUT_PAD * 2;
const FLYOUT_MIN_HEIGHT = 240;
const FLYOUT_MAX_HEIGHT = 820;
const LOGS_WIDTH = 600;
const LOGS_HEIGHT = 520;
const HEALTH_INTERVAL_MS = 2000;
const BUSINESS_INTERVAL_MS = 15_000;
// 服务刚就绪那一轮：首个 /api/tracker 要现编译路由 + 建索引，实测 >5s（第二轮 0.5s），
// 给它 20s，否则面板第一眼永远是「—」。
const COLD_BUSINESS_TIMEOUT_MS = 20_000;
// 业务拉取期间让出服务：但也不能无限期不探健康。
const HEALTH_SKIP_MAX_MS = 10_000;
const TRAY_ICON_SIZE = 32;

const appRoot = path.join(__dirname, "..");
const exeDir = path.dirname(process.execPath);

let tray = null;
let flyout = null;
let logsWindow = null;
let sink = null;
let service = null;
let businessFetcher = null;
let latestBusiness = null;
let latestSnapshot = null;
let quitting = false;
let trayState = "";
let flyoutAnchor = null;
let businessBusy = false;
let businessStartedAt = 0;
let healthBusy = false;

// `CAREER_TRAY_STATE=run|starting|down|failed`（或 `--state=…`）：开发期肉眼校验四态图标，
// 不接管服务、不碰端口（工单 01 验收里的调试开关）。
const DEBUG_STATE = readDebugState();
// `--theme=dark|light`：只改本进程的 nativeTheme.themeSource（不写系统设置），
// 验收时用来截同一份面板的深/浅两套。
const DEBUG_THEME = readDebugTheme();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => toggleFlyout(false, screen.getCursorScreenPoint()));
  app.whenReady().then(bootstrap);
}

app.on("window-all-closed", (event) => {
  // 托盘应用常驻：窗口全关也不退出
  event.preventDefault?.();
});

process.on("unhandledRejection", (error) => {
  // 未处理的 Promise 不能把托盘带走（kaneo 的同款护栏）
  try {
    sink?.line("launcher", `unhandledRejection：${error && error.message ? error.message : String(error)}`);
  } catch {
    /* 日志自己再炸就真没办法了 */
  }
});

function readDebugState() {
  const fromArg = process.argv.find((arg) => arg.startsWith("--state="));
  const raw = (fromArg ? fromArg.slice("--state=".length) : process.env.CAREER_TRAY_STATE || "").trim();
  return ["run", "starting", "down", "failed"].includes(raw) ? raw : "";
}

function readDebugTheme() {
  const fromArg = process.argv.find((arg) => arg.startsWith("--theme="));
  const raw = (fromArg ? fromArg.slice("--theme=".length) : process.env.CAREER_TRAY_THEME || "").trim();
  return ["dark", "light"].includes(raw) ? raw : "";
}

function bootstrap() {
  app.setAppUserModelId("io.santifer.career-ops.tray");
  if (DEBUG_THEME) nativeTheme.themeSource = DEBUG_THEME;

  const careerRoot = runtimeModule.resolveCareerRoot([process.cwd(), appRoot, exeDir]);
  if (!careerRoot) {
    dialog.showErrorBox(
      "career-ops 的数据目录没找到",
      `在以下位置都没找到 data/applications.md：\n${process.cwd()}\n${appRoot}\n${exeDir}\n\n` +
        "把 career-tray/ 放回 career-ops 仓库根目录（与 data/ 同级）后重试。",
    );
    app.quit();
    return;
  }

  sink = logger.createLineSink({ careerRoot });
  const versionInfo = runtimeModule.readVersionFile(appRoot);
  const cacheVersion = String(versionInfo.cacheVersion || "");

  createTray();
  createFlyout();
  registerIpc();
  watchDisplays();

  if (DEBUG_STATE) {
    service = createDebugService(DEBUG_STATE);
    sink.line("launcher", `调试模式：托盘状态固定为 ${DEBUG_STATE}，不接管 3000 端口`);
  } else {
    const runtime = runtimeModule.locateRuntime({ careerRoot, exeDir, cacheVersion });
    if (!runtime) {
      const hint = runtimeModule.runtimeMissingHint(careerRoot);
      sink.line("launcher", hint.replace(/\n+/g, " "));
      dialog.showErrorBox("dashboard 运行时没找到", hint);
      app.quit();
      return;
    }
    // 开发态（直接 `electron tray-shell`）没有打包注入的 version.json：不是错误，
    // service 的第二行日志会写成 cacheVersion=vdev。
    businessFetcher = createBusinessFetcher({
      port: WEB_PORT,
      // 业务块降级时面板只能写「—」；把状态码与耗时记一行日志，否则线上分不清是「服务慢」还是「接口 500」。
      onDegrade: (signature) => sink.line("launcher", `业务数据降级：${signature}`),
    });
    service = createService({
      port: WEB_PORT,
      careerRoot,
      runtime,
      logs: sink,
      cacheVersion,
      openBrowser: () => openDashboard(),
    });
  }

  startTimers();
  pushSnapshot();
  if (!DEBUG_STATE) {
    // 起服期间业务数据必然拉不到（端口还没应答），所以就绪后立刻补一次：
    // 否则面板第一眼全是「—」，得等下一个 15s 轮回填。
    service.start().then((ready) => {
      pushSnapshot();
      if (ready === true) refreshBusiness({ timeoutMs: COLD_BUSINESS_TIMEOUT_MS });
    });
  }
}

// ---------------- 托盘 ----------------

function iconFor(state) {
  return nativeImage.createFromBitmap(drawTrayIcon(state, TRAY_ICON_SIZE), {
    width: TRAY_ICON_SIZE,
    height: TRAY_ICON_SIZE,
  });
}

function createTray() {
  tray = new Tray(iconFor("down"));
  trayState = "down";
  tray.setToolTip("career-ops · 服务已停止");
  tray.on("click", (_event, _bounds, position) => toggleFlyout(false, clickAnchor(position)));
  tray.on("right-click", () => tray.popUpContextMenu(buildTrayMenu()));
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "打开仪表盘", click: () => openDashboard() },
    { label: "显示日志窗口", click: () => showLogs() },
    { label: "重启服务", enabled: service ? service.isRestartable() : false, click: () => restartService() },
    { type: "separator" },
    { label: "退出", click: () => quitApp() },
  ]);
}

/** 点击位置优先；有些外壳转发的点击不带坐标，退回当前鼠标位置。 */
function clickAnchor(position) {
  if (position && (position.x !== 0 || position.y !== 0)) {
    return { x: Math.round(position.x), y: Math.round(position.y) };
  }
  return screen.getCursorScreenPoint();
}

// ---------------- 窗口 ----------------

function baseWindowOptions() {
  return {
    frame: false,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

function createFlyout() {
  flyout = new BrowserWindow({
    ...baseWindowOptions(),
    width: FLYOUT_WINDOW_WIDTH,
    height: 470,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: "#00000000",
  });
  flyout.loadFile(path.join(appRoot, "ui", "panel.html"));
  flyout.on("blur", () => {
    if (quitting) return;
    if (flyout.webContents.isDevToolsOpened()) return;
    flyout.hide();
  });
  flyout.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    flyout.hide();
  });
}

function createLogsWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = display;
  logsWindow = new BrowserWindow({
    ...baseWindowOptions(),
    width: LOGS_WIDTH,
    height: LOGS_HEIGHT,
    minWidth: 560,
    minHeight: 400,
    resizable: true,
    x: Math.round(workArea.x + (workArea.width - LOGS_WIDTH) / 2),
    y: Math.round(workArea.y + (workArea.height - LOGS_HEIGHT) / 2),
    backgroundColor: "#17191C",
  });
  logsWindow.loadFile(path.join(appRoot, "ui", "logs.html"));
  logsWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    logsWindow.hide();
  });
}

function showLogs() {
  if (!logsWindow || logsWindow.isDestroyed()) createLogsWindow();
  logsWindow.show();
  logsWindow.focus();
}

function anchorDisplay(anchor) {
  return anchor ? screen.getDisplayNearestPoint(anchor) : screen.getPrimaryDisplay();
}

function positionFlyout() {
  if (!flyout || flyout.isDestroyed()) return;
  const [width, height] = flyout.getSize();
  const { x, y } = computeFlyoutPosition(anchorDisplay(flyoutAnchor), flyoutAnchor, { width, height });
  flyout.setPosition(x, y, false);
}

/**
 * 开/关面板。`forceOpen` 为 true 时强制打开（单实例第二次双击 = 切换）。
 * 打开时立刻刷一次业务数据 —— 用户点开就想看「现在」的数字。
 */
function toggleFlyout(forceOpen, anchor) {
  if (!flyout || flyout.isDestroyed()) return;
  if (forceOpen === true || !flyout.isVisible()) {
    if (anchor) flyoutAnchor = { x: Math.round(anchor.x), y: Math.round(anchor.y) };
    positionFlyout();
    flyout.show();
    flyout.focus();
    refreshBusiness();
    return;
  }
  flyout.hide();
}

/** 任务栏换边、分辨率/缩放变化、显示器增减：面板开着就立刻重新贴合。 */
function watchDisplays() {
  const reposition = () => {
    if (flyout && flyout.isVisible()) positionFlyout();
  };
  screen.on("display-metrics-changed", reposition);
  screen.on("display-added", reposition);
  screen.on("display-removed", reposition);
}

// ---------------- 快照 ----------------

function pushSnapshot() {
  if (!service) return;
  const snapshot = buildSnapshot({ service: service.facts(), business: latestBusiness });
  snapshot.theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  latestSnapshot = snapshot;

  const state = trayStateOf(snapshot);
  if (tray && state !== trayState) {
    tray.setImage(iconFor(state));
    trayState = state;
  }
  if (tray) tray.setToolTip(trayTooltip(snapshot, WEB_PORT));

  if (flyout && !flyout.isDestroyed()) flyout.webContents.send("shell:snapshot", snapshot);
}

async function refreshBusiness(options = {}) {
  if (!businessFetcher || businessBusy) return;
  businessBusy = true;
  businessStartedAt = Date.now();
  try {
    latestBusiness = await businessFetcher(options);
  } catch {
    latestBusiness = null;
  } finally {
    businessBusy = false;
  }
  pushSnapshot();
}

function startTimers() {
  setInterval(async () => {
    // 业务请求会占住服务的事件循环（实测 /api/tracker 0.5–1.3s），
    // 这时再探健康只会把自己挤超时，面板上就会闪一下「健康 —」。错开跑；
    // 但业务卡住时不能索性不探了，超过 10s 就照探（还有 TCP 复核兜底）。
    if (quitting || healthBusy) return;
    if (businessBusy && Date.now() - businessStartedAt < HEALTH_SKIP_MAX_MS) return;
    healthBusy = true;
    try {
      await service.health();
    } finally {
      healthBusy = false;
    }
    pushSnapshot();
  }, HEALTH_INTERVAL_MS);

  if (!DEBUG_STATE) {
    setInterval(() => {
      if (!quitting) refreshBusiness();
    }, BUSINESS_INTERVAL_MS);
  }

  nativeTheme.on("updated", () => pushSnapshot());
}

// ---------------- 动作 ----------------

function openDashboard() {
  shell.openExternal(service ? service.url : `http://localhost:${WEB_PORT}`);
}

/** `app:openTab` 的取值收敛在这里：四个管道 tab + 跟进页。 */
function tabUrl(tab) {
  const key = String(tab || "").toLowerCase();
  const base = `http://localhost:${WEB_PORT}`;
  if (["applied", "responded", "interview", "offer"].includes(key)) {
    return `${base}/pipeline?tab=${key.toUpperCase()}`;
  }
  if (key === "followups") return `${base}/followups`;
  return base;
}

async function restartService() {
  if (!service || !service.isRestartable()) return { ok: false };
  const ok = await service.restart();
  pushSnapshot();
  refreshBusiness();
  return { ok };
}

async function quitApp() {
  if (quitting) return;
  quitting = true;
  try {
    await service?.stop();
  } catch (error) {
    sink?.line("launcher", `退出清理失败：${error.message}`);
  }
  sink?.line("launcher", "托盘退出");
  sink?.close();
  app.quit();
}

app.on("before-quit", () => {
  quitting = true;
});

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle("shell:snapshot", () => latestSnapshot || (service ? buildSnapshot({ service: service.facts(), business: latestBusiness }) : null));

  ipcMain.handle("service:restart", () => restartService());

  ipcMain.handle("app:openDashboard", () => {
    openDashboard();
  });

  ipcMain.handle("app:openTab", (_event, tab) => {
    shell.openExternal(tabUrl(tab));
  });

  ipcMain.handle("logs:show", () => showLogs());

  ipcMain.handle("app:hideFlyout", () => {
    if (flyout && !flyout.isDestroyed()) flyout.hide();
  });

  ipcMain.handle("window:fit", (event, desiredHeight) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const height = Math.max(FLYOUT_MIN_HEIGHT, Math.min(Math.round(Number(desiredHeight) || 0) || FLYOUT_MIN_HEIGHT, FLYOUT_MAX_HEIGHT));
    const [width] = win.getSize();
    win.setSize(width, height, false);
    if (win === flyout) positionFlyout();
  });

  ipcMain.handle("logs:snapshot", () => ({
    path: sink ? sink.path : "",
    fileOk: sink ? sink.fileOk : false,
    entries: sink ? sink.entries() : [],
  }));

  ipcMain.handle("logs:tail", (_event, afterSeq) => (sink ? sink.tail(Number(afterSeq) || 0) : []));

  ipcMain.handle("logs:openFolder", () => {
    if (sink) shell.showItemInFolder(sink.path);
  });

  ipcMain.handle("logs:clear", () => {
    if (!sink) return { seq: 0 };
    return { seq: sink.clearView() };
  });
}

// ---------------- 调试模式 ----------------

/** 固定四态的假服务：只为肉眼校验图标与面板配色，绝不接管端口。 */
function createDebugService(state) {
  const facts = {
    starting: state === "starting",
    ready: state === "run",
    failed: state === "failed",
    failReason: state === "failed" ? "调试模式：3000 端口 60s 未应答，服务可能启动即崩溃" : "",
    owned: true,
    pid: state === "down" ? 0 : 4242,
    since: Date.now() - 72 * 60 * 1000,
    healthMs: state === "run" ? 38 : null,
    version: "2.41.0",
    coreVersion: "2.41.0",
    sha: "05174d5",
    packaged: false,
  };
  return {
    facts: () => ({ ...facts }),
    start: async () => false,
    restart: async () => false,
    stop: async () => {},
    health: async () => {},
    isRestartable: () => false,
    url: `http://localhost:${WEB_PORT}`,
    port: WEB_PORT,
  };
}
