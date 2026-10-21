"use strict";

// career root 与 dashboard 运行时的定位（工单 02）。
//
// 与旧 Go launcher 的关键差别：**careerRoot 不再等于 exe 所在目录**。Electron 产物是
// `career-tray/` 目录，exe 在它里面一层，而 `data/`、`.dashboard-runtime/`、
// `.career-ops-web/` 都在仓库根。所以先按「哪个候选目录真的含 data/applications.md」
// 把根定下来，之后所有路径都相对它算。

const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_CACHE_DIR = ".dashboard-runtime";
const APP_ENTRY = path.join("app", "server.js");

function defaultFs() {
  return { exists: fs.existsSync, readdir: fs.readdirSync, stat: fs.statSync };
}

/**
 * 候选目录 → career root：自身或父目录含 `data/applications.md` 的那个。
 * 打包产物（career-tray/）命中父目录，开发态（仓库根）命中自身。
 *
 * @param {(string|undefined)[]} candidates 按优先级排列的候选目录
 * @param {{exists?: (p: string) => boolean}} [io]
 * @returns {string} 空串表示没找到
 */
function resolveCareerRoot(candidates, io = {}) {
  const exists = io.exists || fs.existsSync;
  const seen = new Set();
  for (const raw of candidates) {
    if (!raw) continue;
    for (const dir of [raw, path.dirname(raw)]) {
      const key = path.resolve(dir).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (exists(path.join(dir, "data", "applications.md"))) return dir;
    }
  }
  return "";
}

/** 自带运行时（node.exe + app/server.js 与根同级）—— 旧的自包含布局。 */
function findSelfHosted(dir, exists) {
  if (!dir) return null;
  const nodePath = path.join(dir, "node.exe");
  const serverDir = path.join(dir, "app");
  if (exists(nodePath) && exists(path.join(serverDir, "server.js"))) {
    return { nodePath, serverDir, runtimeDir: dir, source: "self-hosted" };
  }
  return null;
}

/**
 * 定位 dashboard 运行时。
 *
 * 顺序：自带运行时 → `.dashboard-runtime/v{cacheVersion}` → 名字以 v 开头且齐全的
 * 最新 mtime 目录。**版本目录优先、不信 mtime**：长时间运行的服务会不断刷新自己
 * runtime 目录的 mtime，「取最新」会锁死在旧构建上（launcher.go 注释里的老坑）。
 *
 * @param {{careerRoot: string, exeDir?: string, cacheVersion?: string, io?: object}} opts
 * @returns {{nodePath: string, serverDir: string, runtimeDir: string, source: string} | null}
 */
function locateRuntime({ careerRoot, exeDir, cacheVersion, io = {} }) {
  const api = { ...defaultFs(), ...io };
  const exists = api.exists;

  for (const dir of [careerRoot, exeDir]) {
    const selfHosted = findSelfHosted(dir, exists);
    if (selfHosted) return selfHosted;
  }

  const cacheBase = path.join(careerRoot, RUNTIME_CACHE_DIR);
  const entries = (() => {
    try {
      return api.readdir(cacheBase, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  if (entries.length === 0) return null;

  const complete = (name) => {
    const dir = path.join(cacheBase, name);
    const nodePath = path.join(dir, "node.exe");
    const serverDir = path.join(dir, "app");
    if (!exists(nodePath) || !exists(path.join(serverDir, "server.js"))) return null;
    return { nodePath, serverDir, runtimeDir: dir };
  };

  const preferredName = `v${cacheVersion || "dev"}`;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name !== preferredName) continue;
    const found = complete(entry.name);
    if (found) return { ...found, source: "versioned" };
  }

  let best = null;
  let bestMtime = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("v")) continue;
    const found = complete(entry.name);
    if (!found) continue;
    let mtime = 0;
    try {
      mtime = api.stat(found.runtimeDir).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (!best || mtime > bestMtime) {
      best = found;
      bestMtime = mtime;
    }
  }
  return best ? { ...best, source: "newest" } : null;
}

/**
 * 读打包注入的版本戳（`resources/app/version.json`，工单 05 写入，替代 Go 的
 * `-ldflags -X main.cacheVersion`）。缺失时给空对象 —— 调用方按 `vdev` 处理并在日志里明说。
 *
 * @param {string} appRoot `tray-shell/` 或 `resources/app/`
 */
function readVersionFile(appRoot, io = {}) {
  const exists = io.exists || fs.existsSync;
  const file = path.join(appRoot, "version.json");
  if (!exists(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 给用户的行动指引：运行时缺失时唯一正确的下一步。 */
function runtimeMissingHint(careerRoot) {
  return [
    "dashboard runtime not found.",
    "",
    "Run: node dashboard-ui/build-dashboard-ui.mjs",
    `（产物应出现在 ${path.join(careerRoot, RUNTIME_CACHE_DIR, "v<sha>")}）`,
  ].join("\n");
}

module.exports = {
  APP_ENTRY,
  RUNTIME_CACHE_DIR,
  locateRuntime,
  readVersionFile,
  resolveCareerRoot,
  runtimeMissingHint,
};
