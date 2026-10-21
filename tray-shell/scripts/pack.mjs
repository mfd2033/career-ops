#!/usr/bin/env node
// tray-shell/scripts/pack.mjs — 免安装打包：Electron 预编译运行时 + 应用本体 → career-tray/
//
// 不用 electron-builder（构建期二进制 + NSIS 与「放进去双击就跑」的形态冲突，且本机代理环境
// 下载易失败；Kaneo 的 pack.mjs 也是为此手写）。产物结构与职责见 docs/launcher-packaging.md。
//
// 用法（通常由 dashboard-ui/build-dashboard-ui.mjs 调用，或 `npm run tray:pack` 裸打包）：
//   node tray-shell/scripts/pack.mjs --cache-version=abc1234 [--sha=abc1234] [--built-at="…"]
//
// 前置缺失一律非零退出并给可执行命令，绝不静默降级（ADR-0086 决策 8）。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(scriptsDir); // tray-shell/
const repoRoot = path.dirname(appRoot);
const outDir = path.join(repoRoot, "career-tray");
const exeName = "CareerDashboardTray.exe";
const exePath = path.join(outDir, exeName);
const packagedAppDir = path.join(outDir, "resources", "app");
const electronDist = path.join(repoRoot, "node_modules", "electron", "dist");
const icoPath = path.join(repoRoot, "dashboard-ui", "icon.ico");
const KEEP_LOCALES = new Set(["en-US.pak", "zh-CN.pak"]);

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const withEq = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (withEq) return withEq.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index === -1 ? "" : argv[index + 1] || "";
};

function die(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`  下一步：${hint}`);
  process.exit(1);
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          /* 杀软短暂占用时跳过单个文件，体积估算不值得失败 */
        }
      }
    }
  };
  walk(dir);
  return total / (1024 * 1024);
}

// ── 前置 ────────────────────────────────────────────────────────────────────
if (!existsSync(path.join(electronDist, "electron.exe"))) {
  die(
    `找不到 Electron 运行时：${path.join(electronDist, "electron.exe")}`,
    "node node_modules/electron/install.js（代理环境可先设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）",
  );
}
if (!existsSync(path.join(repoRoot, "node_modules", "resedit"))) {
  die("找不到 resedit（打包时要往 exe 里嵌图标）", "npm i -D resedit");
}

const cacheVersion = valueOf("--cache-version") || "dev";
const sha = valueOf("--sha") || "";
const builtAt = valueOf("--built-at") || new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

// ── 1. 清旧产物 ─────────────────────────────────────────────────────────────
// Windows 上资源管理器/杀软会短暂占用旧目录，退避重试（Kaneo 同款参数）。
rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
mkdirSync(outDir, { recursive: true });

// ── 2. 复制 Electron 运行时 ─────────────────────────────────────────────────
cpSync(electronDist, outDir, { recursive: true });

const sourceExe = path.join(outDir, "electron.exe");
if (!existsSync(sourceExe)) die("运行时里没有 electron.exe，无法打包", "重新执行 node node_modules/electron/install.js");
renameSync(sourceExe, exePath);

// ── 3. 应用本体（只带运行期需要的文件，不带 tests/scripts）──────────────────
rmSync(path.join(outDir, "resources", "default_app.asar"), { force: true });
mkdirSync(packagedAppDir, { recursive: true });
for (const entry of ["package.json", "src", "ui"]) {
  cpSync(path.join(appRoot, entry), path.join(packagedAppDir, entry), { recursive: true });
}

// ── 4. 版本戳（替代 Go 的 -ldflags -X main.cacheVersion）────────────────────
writeFileSync(
  path.join(packagedAppDir, "version.json"),
  `${JSON.stringify({ cacheVersion, sha, builtAt }, null, 2)}\n`,
  "utf8",
);

// ── 5. 裁剪 locale（55 个 48 MB → 2 个约 2 MB）─────────────────────────────
const localesDir = path.join(outDir, "locales");
if (existsSync(localesDir)) {
  for (const file of readdirSync(localesDir)) {
    if (!KEEP_LOCALES.has(file)) rmSync(path.join(localesDir, file), { force: true });
  }
}

// ── 6. 嵌入品牌图标（Electron 运行时默认带的是它自己的图标）────────────────
if (existsSync(icoPath)) {
  const ResEdit = require("resedit");
  const exe = ResEdit.NtExecutable.from(readFileSync(exePath));
  const resource = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(readFileSync(icoPath));
  const groupIds = ResEdit.Resource.IconGroupEntry.fromEntries(resource.entries).map((entry) => entry.id);
  for (const id of groupIds) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      resource.entries,
      id,
      1033,
      iconFile.icons.map((item) => item.data),
    );
  }
  resource.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  已嵌入图标  ${groupIds.length} 个图标组（${iconFile.icons.length} 个尺寸）`);
} else {
  die(`找不到图标源 ${icoPath}`, "dashboard-ui/icon.ico 是打包嵌图标与托盘图标的共同来源，先恢复它");
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
const locales = existsSync(localesDir) ? readdirSync(localesDir) : [];
console.log("打包完成：");
console.log(`  可执行文件  ${exePath}`);
console.log(`  应用目录    ${packagedAppDir}`);
console.log(`  cacheVersion ${cacheVersion}${sha ? `（sha ${sha}）` : ""}`);
console.log(`  locales     ${locales.join(", ") || "(无)"}`);
console.log(`  总体积      ${dirSizeMb(outDir).toFixed(0)} MB`);
