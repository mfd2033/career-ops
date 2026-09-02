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
const LOCK_FILE = path.join(RUNTIME_DIR, 'LOCK');
const LOG_FILE = path.join(RUNTIME_DIR, 'tray-debug.log');

let tray = null;
let serverProcess = null;
let port = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) { /* ignore */ }
}

function readPortFromLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const line = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const p = parseInt(line, 10);
      if (!isNaN(p) && p > 0) return p;
    }
  } catch (e) { /* ignore */ }
  return 0;
}

function writeLockFile(p) {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, p.toString());
  } catch (e) { /* ignore */ }
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

function pickFreePort() {
  // Use net module to find a free port
  const net = require('net');
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const p = server.address().port;
    server.close();
    return p;
  });
  // Synchronous fallback: try common ports
  return 3000;
}

function killNodeProcesses() {
  // Kill any existing node processes on our port
  try {
    const result = execSync(
      'netstat -ano | findstr ":' + port + '" | findstr "LISTENING"',
      { encoding: 'utf8', shell: 'cmd' }
    );
    const lines = result.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        const pid = parseInt(parts[4], 10);
        if (!isNaN(pid)) {
          try {
            execSync(`taskkill /PID ${pid} /F`, { shell: 'cmd' });
            log(`killed node pid=${pid} on port ${port}`);
          } catch (e) { /* already dead */ }
        }
      }
    }
  } catch (e) { /* no matching processes */ }
}

function startServer() {
  // Stop existing server first
  stopServer();

  port = readPortFromLock();
  if (!port) port = pickFreePort();

  const careerOpsRoot = findCareerOpsRoot();
  const serverJs = path.join(careerOpsRoot, 'web', '.next', 'standalone', 'server.js');
  const standaloneDir = path.join(careerOpsRoot, 'web', '.next', 'standalone');

  if (!fs.existsSync(serverJs)) {
    log(`ERROR: server.js not found at ${serverJs}`);
    return;
  }

  // Kill existing server on this port
  killNodeProcesses();

  // Write lock file
  writeLockFile(port);

  // Start Node process
  const env = {
    ...process.env,
    CAREER_OPS_ROOT: careerOpsRoot,
    PORT: port.toString(),
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
    port = 0;
  });

  serverProcess.on('error', (err) => {
    log(`server failed to start: ${err.message}`);
  });

  log(`server started: port=${port} pid=${serverProcess.pid} root=${careerOpsRoot}`);

  // Wait for server to be ready
  waitForServerReady(port);
}

function waitForServerReady(targetPort, maxAttempts = 30) {
  const http = require('http');
  let attempts = 0;

  const check = () => {
    attempts++;
    const req = http.get(`http://127.0.0.1:${targetPort}/api/version`, (res) => {
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
  port = 0;
}

function restartServer() {
  log('restart requested');
  stopServer();
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (e) { /* ignore */ }
  startServer();
}

function openBrowser() {
  if (!port) port = readPortFromLock();
  if (!port) port = 3000;

  const url = `http://localhost:${port}`;
  require('child_process').exec(`start "" "${url}"`, (err) => {
    if (err) log(`browser open failed: ${err.message}`);
    else log(`browser opened: ${url}`);
  });
}

function quitApp() {
  log('quit requested');
  stopServer();
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (e) { /* ignore */ }
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
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (e) { /* ignore */ }
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
