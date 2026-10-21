#!/usr/bin/env node
// build-dashboard-ui.mjs — 构建 career-ops web 并打包成托盘壳（默认 Electron，ADR-0086）。
//
// Pipeline:
//   1. next build (standalone output)   → web/.next/standalone
//   2. copy .next/static into the standalone tree (Next does not do this)
//   3. strip traced dev files (src/, tests/, logs, configs) out of standalone
//   4. copy the clean standalone tree  → dashboard-ui/app   (runtime source)
//   5. copy the running node binary     → dashboard-ui/node.exe (runtime source)
//   5b/5c. stamp build-info.json +预置 .dashboard-runtime/v{cacheVersion}
//   6. 壳：
//      --shell=electron（默认）→ tray-shell/scripts/pack.mjs 产出 career-tray/ 目录
//      --shell=go（回滚）      → go-winres + go build 产出仓库根的 9 MB exe
//
// Requires: Node (builds the web app)；--shell=go 额外需要 Go 1.24+ 与 go-winres
// （首次自动装进 dashboard-ui/.gobin）。Run from anywhere:
//   node dashboard-ui/build-dashboard-ui.mjs                 # Electron 壳（默认）
//   node dashboard-ui/build-dashboard-ui.mjs --shell=go      # 回滚旧 exe
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "web");
const uiDir = path.join(root, "dashboard-ui");
const gobinDir = path.join(uiDir, ".gobin");
const goWinres = path.join(gobinDir, "go-winres.exe");

// ── 壳的选择（ADR-0086 决策 1）─────────────────────────────────────────────
// 默认 electron：产物是 career-tray/ 目录。--shell=go 保留旧 exe 的产出路径，作回滚开关。
const argv = process.argv.slice(2);
const flagValue = (flag) => {
  const withEq = argv.find((a) => a.startsWith(`${flag}=`));
  if (withEq) return withEq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i === -1 ? "" : argv[i + 1] || "";
};

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`build-dashboard-ui.mjs — 构建 web 并打包托盘壳

用法：
  node dashboard-ui/build-dashboard-ui.mjs                 Electron 壳（默认）→ career-tray/
  node dashboard-ui/build-dashboard-ui.mjs --shell=go      回滚：产出 career-dashboard-launcher.exe
  node dashboard-ui/build-dashboard-ui.mjs --help

两种壳共用第 1–5c 步（Next 构建、运行时目录预置）；只有第 6 步不同。
Go 源码已冻结（dashboard-ui/*.go），仍保留单测与回滚能力。`);
  process.exit(0);
}

const SHELL = flagValue("--shell") || "electron";
if (!["electron", "go"].includes(SHELL)) {
  console.error(`✗ 不认识的 --shell=${SHELL}（只支持 electron / go）`);
  process.exit(1);
}

function run(cmd, cwd, env = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

// ── Windows copy hardening ───────────────────────────────────────────────────
// The big tree copies below failed twice in a row (2026-09-24) with ENOENT on
// the DEST side (…app\.next\node_modules) immediately after a fresh next build,
// while the identical copy of the same settled tree succeeded minutes later.
// Two suspects, both handled here: cpSync's symlink-dereference path (flaky on
// Windows — hand it a link-free tree instead) and transient fresh-file state
// (retry with backoff).

/** Replace every symlink under rootDir with a real copy of its target. */
function dereferenceTree(rootDir) {
  let replaced = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = fs.realpathSync(full); // throws if the link is broken
        fs.rmSync(full, { recursive: true, force: true });
        fs.cpSync(target, full, { recursive: true, dereference: true });
        replaced++;
        walk(full); // the target itself may contain further symlinks
      } else if (e.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(rootDir);
  if (replaced) console.log(`dereferenced ${replaced} symlink(s) under ${rootDir}`);
}

/** fs.cpSync with a small retry — covers transient AV/indexer locks. */
function cpSyncRetry(src, dest, opts = {}, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.cpSync(src, dest, opts);
      return;
    } catch (err) {
      if (attempt >= tries) throw err;
      console.log(`cpSync → ${path.basename(dest)} failed (${err.code}); retry ${attempt}/${tries - 1} in ${attempt * 2}s …`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 2000);
    }
  }
}

// ── PE 子系统守卫（ADR-0066 修订 2）────────────────────────────────────────
// 日常双击入口必须是 GUI 子系统：控制台子系统会随双击创建一个控制台窗口，
// 而 Windows Terminal 默认终端下该窗口既不归本进程、也隐不掉（实测：GetConsoleWindow
// 返回进程内不可见的 PseudoConsoleWindow，SW_HIDE 对屏幕上的 WT 窗口无效）。
// 构建后直接读 PE 头校验，防止有人改回控制台子系统而回归。
const PE_SUBSYSTEM_WINDOWS_GUI = 2;
const PE_SUBSYSTEM_CONSOLE = 3;

/** 读 PE 可选头里的 Subsystem：e_lfanew 在 0x3C，COFF 头 20 字节后为可选头，Subsystem 在可选头 +0x44（IMAGES_OPTIONAL_HEADER64 布局）。 */
function peSubsystem(file) {
  const buf = fs.readFileSync(file);
  const optionalHeader = buf.readUInt32LE(0x3c) + 24;
  return buf.readUInt16LE(optionalHeader + 0x44);
}

// 0. ensure go-winres is available（只有 --shell=go 需要）
if (SHELL === "go" && !fs.existsSync(goWinres)) {
  console.log("installing go-winres into .gobin …");
  run(`go install github.com/tc-hib/go-winres@latest`, root, { GOBIN: gobinDir });
}

// 1. build the standalone server (default .next distDir keeps server.js clean)
run("npm run build", webDir, { WEB_STANDALONE: "1" });

const standalone = path.join(webDir, ".next", "standalone");

// 2. Next does not copy .next/static into standalone — do it here.
// dereference: the standalone tree contains symlinks (e.g. playwright-core)
// that Windows can't re-create without privileges — copy their targets instead.
cpSyncRetry(path.join(webDir, ".next", "static"), path.join(standalone, ".next", "static"), {
  recursive: true,
  dereference: true,
});

// 3. strip dev/traced junk that the dynamic-fs trace pulled into standalone.
const junk = [
  "src",
  "tests",
  "AGENTS.md",
  "CLAUDE.md",
  "CHANGELOG.md",
  "README.md",
  "next.config.mjs",
  "tsconfig.json",
  "package-lock.json",
  "postcss.config.mjs",
];
for (const f of junk) fs.rmSync(path.join(standalone, f), { recursive: true, force: true });
for (const f of fs.readdirSync(standalone)) {
  if (f.endsWith(".log")) fs.rmSync(path.join(standalone, f), { force: true });
}

// 4. refresh the Go embed source for the app tree.
fs.rmSync(path.join(uiDir, "app"), { recursive: true, force: true });
dereferenceTree(standalone); // cpSync's dereference path is flaky on Windows — hand it a link-free tree
cpSyncRetry(standalone, path.join(uiDir, "app"), {
  recursive: true,
  dereference: true,
});

// 5. refresh the embedded node runtime (the Node that runs this script).
fs.copyFileSync(process.execPath, path.join(uiDir, "node.exe"));

// 5b. stamp the embedded app with build provenance: the git SHA this build was
// made from, a UTC timestamp, and the cacheVersion the launcher will derive its
// runtime dir from. The web /api/version reads this file instead of running git
// at runtime — so the page's footer shows the PACKAGED build's commit, which is
// what tells the user whether the exe (not the working tree) is up to date.
const buildSha = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
})();
// Uncommitted changes share HEAD's sha — without a dirty marker the packer
// would rebuild into the SAME runtime dir, and ensureRuntime's OK-file check
// would silently serve the PREVIOUS extraction. `-dirty` forces a fresh dir.
const dirty = (() => {
  try {
    return execSync("git status --porcelain", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
  } catch {
    return false;
  }
})();
const builtAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
const cacheVersion = buildSha ? `${buildSha}${dirty ? "-dirty" : ""}` : `dev-${Date.now()}`;
// The core (repo-root) VERSION frozen at pack time. The standalone bundle
// carries no VERSION file, so /api/version's on-disk read returns "" in a
// packaged build — without this the UI's bug report loses the core version and
// an RC pack would mis-derive its channel (#8). Parsed the same way the API
// reads the file: first whitespace-delimited token.
const coreVersion = (() => {
  try {
    return fs.readFileSync(path.join(root, "VERSION"), "utf8").split(/\s+/)[0].trim();
  } catch {
    return "";
  }
})();
fs.writeFileSync(path.join(uiDir, "app", "build-info.json"), JSON.stringify({ sha: buildSha, builtAt, cacheVersion, coreVersion }, null, 2));

// 5c. Prepare the extracted-runtime layout the launcher reads: launcher.go
// resolves node.exe + app/server.js from a `.dashboard-runtime\v{cacheVersion}\`
// dir next to the exe (locateLegacyCache), preferring the dir whose name
// matches ITS OWN injected cacheVersion over the newest-by-mtime. The README
// has always promised a full build produces this layout; the launcher reuses
// the newest dir as a fallback, but only a versioned one guarantees a rebuild
// serves the NEW web build (a long-running server keeps touching its own
// runtime dir, so "newest mtime" converges on the stale extraction).
const runtimeCacheDir = path.join(root, ".dashboard-runtime", `v${cacheVersion}`);
fs.rmSync(runtimeCacheDir, { recursive: true, force: true });
fs.mkdirSync(path.join(runtimeCacheDir, "app"), { recursive: true });
cpSyncRetry(path.join(uiDir, "app"), path.join(runtimeCacheDir, "app"), { recursive: true, dereference: true });
fs.copyFileSync(process.execPath, path.join(runtimeCacheDir, "node.exe"));
console.log(`✓ prepared runtime cache ${runtimeCacheDir} (v${cacheVersion})`);

// 6. 壳：默认 Electron（tray-shell/scripts/pack.mjs），--shell=go 回滚旧 exe。
if (SHELL === "electron") {
  // 免安装打包：copy Electron 运行时 + 改名 + resedit 嵌图标（不用 electron-builder，见 ADR-0086 决策 8）。
  const args = ["tray-shell/scripts/pack.mjs", `--cache-version=${cacheVersion}`, `--built-at=${builtAt}`];
  if (buildSha) args.push(`--sha=${buildSha}`);
  console.log(`\n$ node ${args.join(" ")}`);
  const packed = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  const stdout = String(packed.stdout || "");
  const stderr = String(packed.stderr || "");
  if (packed.status !== 0) {
    // 失败时只印子进程最后 20 行，把真正的错因（前置缺件 / 文件被占）留在屏幕上。
    const tail = `${stdout}${stderr}`.trimEnd().split(/\r?\n/).slice(-20).join("\n");
    throw new Error(`tray-shell/scripts/pack.mjs 退出码 ${packed.status}：\n${tail}`);
  }
  process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
  console.log(`\n✓ career-tray/ 已就绪（cacheVersion=v${cacheVersion}）`);
} else {
  // 回滚路径：旧 Go 壳（ADR-0066 修订 2 的 GUI 子系统与 PE 子系统守卫原样保留）。
  // 6. regenerate the Windows resources (icon + manifest + version) as .syso.
  run(`${goWinres} make --arch amd64`, uiDir);

  // 7. Lightweight launcher (~9 MB): no embedded runtime, reads from cache dir.
  // cacheVersion injection prevents the launcher falling back to newest-by-mtime
  // and silently serving a stale .dashboard-runtime extraction after a rebuild.
  // -ldflags "-H windowsgui"（ADR-0066 修订 2）：GUI 子系统，双击启动全程无控制台窗口；
  // 从终端/脚本拉起时由 launcher 自己 AttachConsole(父进程) 接回 stdout，重定向/管道则原样保留。
  // 注意 -H 是链接器选项，必须包在 -ldflags 里（`go build -H ...` 会被当成非法 build flag）。
  const out = path.join(root, "career-dashboard-launcher.exe");
  run(`go build -ldflags "-H windowsgui -X main.cacheVersion=${cacheVersion}" -o ..\\career-dashboard-launcher.exe .`, uiDir);
  const subsystem = peSubsystem(out);
  if (subsystem !== PE_SUBSYSTEM_WINDOWS_GUI) {
    const kind = subsystem === PE_SUBSYSTEM_CONSOLE ? "console(3)" : `${subsystem}`;
    throw new Error(
      `launcher 子系统校验失败：期望 GUI(${PE_SUBSYSTEM_WINDOWS_GUI})，实际 ${kind}。` +
        "控制台子系统会在双击时弹出隐不掉的控制台窗口（ADR-0066 修订 2），拒绝产出。",
    );
  }
  const mb = (fs.statSync(out).size / (1024 * 1024)).toFixed(1);
  console.log(`\n✓ ${out} (${mb} MB, subsystem=GUI)`);
}
