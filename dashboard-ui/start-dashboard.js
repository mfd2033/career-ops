#!/usr/bin/env node
/**
 * career-ops dashboard launcher (Node.js version)
 * Lightweight alternative to career-dashboard-ui.exe
 *
 * Usage:
 *   node dashboard-ui/start-dashboard.js
 *   # or double-click via a .bat file
 */

'use strict';

const { app, Tray, Menu, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────
const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const ICON_PATH = path.join(SCRIPT_DIR, 'icon-256.png');
const RUNTIME_DIR = path.join(PROJECT_ROOT, '.dashboard-runtime');
const LOG_FILE = path.join(RUNTIME_DIR, 'tray-debug.log');

// ADR-0063: the web port is pinned to 3000 — never drifts to another port.
const WEB_PORT = 3000;

let tray = null;
let serverProcess = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* ignore */ }
}

function sleepMs(ms) {
  // Synchronous wait (Atomics on a zero-length SharedArrayBuffer) — the caller
  // is a blocking port-release poll between kill and bind; async would need a
  // whole callback pyramid for no benefit here.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function portInUse() {
  try {
    const result = execSync(`netstat -ano | findstr ":${WEB_PORT}" | findstr "LISTENING"`, { encoding: 'utf8', shell: 'cmd' });
    return result.trim().length > 0;
  } catch (e) {
    return false; // findstr exits 1 when nothing matched → port is free
  }
}

function findCareerOpsRoot() {
  // Start from script directory and scan up
  let dir = SCRIPT_DIR;
  for (let i = 0; i < 5; i++) {
    const candidate = dir;
    if (
      fs.existsSync(path.join(candidate, 'web', '.next', 'standalone'))
    ) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }
  return PROJECT_ROOT; // fallback
}

// ADR-0063 probe: does a live web already answer on the pinned port?
function probeAlive(cb) {
  const http = require('http');
  const req = http.get(`http://localhost:${WEB_PORT}/api/version`, (res) => {
    res.resume();
    cb(res.statusCode === 200);
  });
  req.on('error', () => cb(false));
  req.setTimeout(1500, () => { req.destroy(); cb(false); });
}

// ADR-0063: force-kill whatever LISTENs on the pinned port and its child tree
// (taskkill /T /F), then wait for the port to free. Targets any process, not
// only node — mirrors start-web.cmd. Returns false if an owner stays, so the
// caller errors out instead of drifting to another port.
function killPortOwner() {
  let result = '';
  try {
    result = execSync(`netstat -ano | findstr ":${WEB_PORT}" | findstr "LISTENING"`, { encoding: 'utf8', shell: 'cmd' });
  } catch (e) {
    return true; // nothing matched → port free
  }
  const pids = new Set();
  for (const line of result.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5) {
      const pid = parseInt(parts[4], 10);
      if (!isNaN(pid) && pid > 0) pids.add(pid);
    }
  }
  for (const pid of pids) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { shell: 'cmd' }); log(`killed port owner pid=${pid} (tree)`); }
    catch (e) { log(`taskkill pid=${pid} failed: ${e.message}`); }
  }
  for (let i = 0; i < 40; i++) { // up to ~10s
    if (!portInUse()) return true;
    sleepMs(250);
  }
  return !portInUse();
}

function startServer() {
  // Stop existing server first
  stopServer();

  // ADR-0063: reuse a live instance (standalone OR dev) on the pinned port;
  // never start a second server, never drift to another port.
  probeAlive((alive) => {
    if (alive) {
      log(`port ${WEB_PORT} already serves a live web — reusing it`);
      openBrowser();
      return;
    }
    launch();
  });
}

function launch() {
  const careerOpsRoot = findCareerOpsRoot();
  const serverJs = path.join(careerOpsRoot, 'web', '.next', 'standalone', 'server.js');
  const standaloneDir = path.join(careerOpsRoot, 'web', '.next', 'standalone');

  if (!fs.existsSync(serverJs)) {
    log(`ERROR: server.js not found at ${serverJs}`);
    return;
  }

  // ADR-0063: evict whatever owns the pinned port before binding. If it can't be
  // freed, error out — do NOT fall back to another port.
  if (!killPortOwner()) {
    log(`ERROR: port ${WEB_PORT} is occupied and could not be freed (pinned, no fallback port)`);
    return;
  }

  // Start Node process
  const env = {
    ...process.env,
    CAREER_OPS_ROOT: careerOpsRoot,
    PORT: WEB_PORT.toString(),
    // Bind address, not an access URL: keep the explicit IPv4 loopback literal.
    // Windows resolves `localhost` to ::1 first, so HOSTNAME=localhost would
    // bind the IPv6 loopback and break the 127.0.0.1 clients (extension probe).
    HOSTNAME: '127.0.0.1',
    NODE_ENV: 'production'
  };

  serverProcess = spawn('node', [serverJs], {
    cwd: standaloneDir,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  });

  serverProcess.stdout.on('data', (data) => {
    log(`out: ${data.toString().trim()}`);
  });

  serverProcess.stderr.on('data', (data) => {
    log(`err: ${data.toString().trim()}`);
  });

  serverProcess.on('exit', (code, signal) => {
    log(`server exited with code ${code}, signal ${signal}`);
    serverProcess = null;
  });

  serverProcess.on('error', (err) => {
    log(`server failed to start: ${err.message}`);
  });

  log(`server started: port=${WEB_PORT} pid=${serverProcess.pid} root=${careerOpsRoot}`);

  // Wait for server to be ready
  waitForServerReady(WEB_PORT);
}

function waitForServerReady(targetPort, maxAttempts = 30) {
  const http = require('http');
  let attempts = 0;

  const check = () => {
    attempts++;
    // Access URL uses `localhost` per the house rule (_custom.md); Node's
    // autoSelectFamily falls back to 127.0.0.1 when ::1 refuses the connect.
    const req = http.get(`http://localhost:${targetPort}/api/version`, (res) => {
      if (res.statusCode === 200) {
        log(`server ready: port=${targetPort}`);
        openBrowser();
        return;
      }
    });
    req.on('error', (err) => {
      if (attempts >= maxAttempts) {
        log(`WARNING: server may not be ready yet`);
        openBrowser(); // try anyway
      }
    });
    req.setTimeout(1000, () => {
      req.destroy();
    });
  };

  // Poll every 500ms
  const interval = setInterval(() => {
    check();
  }, 500);

  // Stop polling after max time
  setTimeout(() => {
    clearInterval(interval);
  }, maxAttempts * 500 + 1000);
}

function stopServer() {
  if (serverProcess) {
    try {
      serverProcess.kill('SIGTERM');
      log(`stopped server pid=${serverProcess.pid}`);
    } catch (e) { /* ignore */ }
    serverProcess = null;
  }
}

function restartServer() {
  log('restart requested');
  stopServer();
  // startServer re-probes and, after our child releases 3000, re-launches on the
  // same pinned port (ADR-0063). No port re-pick, no LOCK.
  startServer();
}

function openBrowser() {
  const url = `http://localhost:${WEB_PORT}`;
  require('child_process').exec(`start "" "${url}"`, (err) => {
    if (err) log(`browser open failed: ${err.message}`);
    else log(`browser opened: ${url}`);
  });
}

function quitApp() {
  log('quit requested');
  stopServer();
  if (tray) tray.destroy();
  app.quit();
}

// ─── Tray Menu ────────────────────────────────────────────────────────────────

function createTrayMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Panel',
      click: () => openBrowser()
    },
    { type: 'separator' },
    {
      label: 'Restart Server',
      click: () => restartServer()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => quitApp()
    }
  ]);
  return menu;
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.on('ready', () => {
  // Ensure runtime dir exists
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }

  log('Dashboard launcher starting...');
  log(`Icon path: ${ICON_PATH}`);
  log(`Runtime dir: ${RUNTIME_DIR}`);
  log(`Project root: ${PROJECT_ROOT}`);

  // Check icon exists
  if (!fs.existsSync(ICON_PATH)) {
    log(`WARNING: Icon not found at ${ICON_PATH}`);
  }

  // Start server
  startServer();

  // Create tray icon
  try {
    const iconPath = ICON_PATH;
    tray = new Tray(iconPath);
    tray.setToolTip('Career-Ops Dashboard');
    tray.setContextMenu(createTrayMenu());

    tray.on('click', () => {
      openBrowser();
    });

    log('Tray icon created successfully');
  } catch (e) {
    log(`Failed to create tray icon: ${e.message}`);
    // Still keep app alive
  }
});

app.on('window-all-closed', () => {
  // Keep running in tray
});

app.on('before-quit', () => {
  stopServer();
});

// Handle IPC from renderer (if needed)
ipcMain.on('restart-server', () => {
  restartServer();
});

ipcMain.on('open-browser', () => {
  openBrowser();
});

ipcMain.on('quit-app', () => {
  quitApp();
});
