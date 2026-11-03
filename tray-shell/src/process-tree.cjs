"use strict";

// 进程树的最小纯函数集（ADR-0063「修订二」的落地）。
//
// 为什么它住在这里、而不是打包脚本里：`local/` 是 gitignored 的 fork-local 层
// （ADR-0022），写在那儿的「绝不 `taskkill /T`、绝不杀浏览器子树」没有任何可审查、
// 可回归的产物——换台机器按文档重写一遍打包脚本，2026-11-03 那次「停壳连坐杀掉
// 用户整个 Edge（23 个标签页）」的事故就原样复现。
//
// 分工：判定与走树放这里（无副作用、可 `node --test`），spawn/kill/日志留在调用方
// （`local/pack-launcher.mjs` 在打包链路上，`service.cjs` 在托盘壳里）。

/**
 * 浏览器进程一律不碰（用户要求 2026-11-03）：替用户关浏览器不在壳与打包的职责内。
 * 壳用 `shell.openExternal` 打开仪表盘时浏览器会挂在壳名下，所以它必然出现在
 * 「该结束的进程树」里——跳过它，而不是杀掉它。
 */
const BROWSER_IMAGES = new Set(["msedge.exe", "chrome.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe"]);

/** 该映像名是不是浏览器（大小写与空白折叠）。 */
function isBrowserImage(name) {
  return BROWSER_IMAGES.has(String(name || "").trim().toLowerCase());
}

/**
 * 打死也不碰的映像：进程树算错了也不能拿它们赌（Windows 没有真子进程会崩）。
 * 2026-11-03 实测：`csrss.exe` / `wininit.exe` 报的 `ParentProcessId` 就是壳的 pid
 * ——那是开机时某个早已退出的进程留下的 PID，今天被壳复用了。
 */
const NEVER_KILL = new Set([
  "system",
  "registry",
  "memcompression",
  "smss.exe",
  "csrss.exe",
  "wininit.exe",
  "winlogon.exe",
  "services.exe",
  "lsass.exe",
  "lsaiso.exe",
  "svchost.exe",
  "explorer.exe",
]);

/** 浏览器 + 系统关键进程：任何情况下都不结束。 */
function isProtectedImage(name) {
  const key = String(name || "").trim().toLowerCase();
  return BROWSER_IMAGES.has(key) || NEVER_KILL.has(key);
}

/**
 * 解析 `Get-CimInstance Win32_Process` 的 `pid|ppid|name|creationDate` 行文本。
 *
 * createdAt 用 `ToFileTimeUtc()`（100ns 单位）。它超过 `Number.MAX_SAFE_INTEGER`，
 * `Number()` 会丢末尾几位——但这里只比较「子进程是否比父进程还老」，差的量级是秒，
 * 丢掉的精度（微秒级）不影响判定，保留原有语义。
 *
 * @param {string} text
 * @returns {Array<{pid: number, ppid: number, name: string, createdAt: number}>}
 */
function parseProcessTable(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, name, created] = line.split("|");
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        name: String(name || "").toLowerCase(),
        createdAt: Number(created) || 0,
      };
    })
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

/**
 * pid 的整棵进程树（含自身），父在前、子在后。
 *
 * **必须按创建时间过滤**：`ParentProcessId` 只是「创建时的父 PID」，父进程退出后
 * 这个数字会被别人复用，于是开机就存在的 csrss / wininit 也会报成壳的子进程。
 * 子进程不可能比父进程老，用 createdAt 把这种假链接挡掉。
 *
 * @param {ReturnType<typeof parseProcessTable>} table
 * @param {number} rootPid
 */
function treeOf(table, rootPid) {
  const rows = table || [];
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return [];
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const out = [];
  const seen = new Set();
  const walk = (row) => {
    if (seen.has(row.pid)) return;
    seen.add(row.pid);
    out.push(row);
    for (const child of byParent.get(row.pid) || []) {
      if (child.createdAt < row.createdAt) continue; // PPID 复用：比父进程还老，一定不是它的子进程
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * 一棵树的结束计划。
 *
 * - `kill`：可以结束的，**子进程在前**（父进程最后死，否则先杀父会让子进程的父 PID
 *   变成 0，再按树找就找不到了）；
 * - `skipped`：浏览器与系统关键进程，一律不碰。
 *
 * @param {ReturnType<typeof parseProcessTable>} table
 * @param {number} rootPid
 * @returns {{kill: Array<{pid: number, name: string}>, skipped: Array<{pid: number, name: string}>}}
 */
function killPlan(table, rootPid) {
  const rows = treeOf(table, rootPid);
  const kill = [];
  const skipped = [];
  for (const row of rows.slice().reverse()) {
    const entry = { pid: row.pid, name: row.name };
    if (isProtectedImage(row.name)) skipped.push(entry);
    else kill.push(entry);
  }
  return { kill, skipped };
}

module.exports = {
  BROWSER_IMAGES,
  NEVER_KILL,
  isBrowserImage,
  isProtectedImage,
  parseProcessTable,
  treeOf,
  killPlan,
};
