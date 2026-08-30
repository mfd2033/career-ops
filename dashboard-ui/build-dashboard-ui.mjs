#!/usr/bin/env node
// build-dashboard-ui.mjs — package the career-ops web UI into the self-contained
// career-dashboard-ui.exe launcher.
//
// Pipeline:
//   1. next build (standalone output)   → web/.next/standalone
//   2. copy .next/static into the standalone tree (Next does not do this)
//   3. strip traced dev files (src/, tests/, logs, configs) out of standalone
//   4. copy the clean standalone tree  → dashboard-ui/app   (Go embed source)
//   5. copy the running node binary     → dashboard-ui/node.exe (Go embed source)
//   6. go-winres make                   → rsrc_windows_amd64.syso (icon + manifest)
//   7. go build -H windowsgui           → career-dashboard-ui.exe (repo root)
//
// Requires: Node (builds the web app), Go 1.24+, and go-winres (auto-installed
// on first run into dashboard-ui/.gobin). Run from anywhere:
//   node dashboard-ui/build-dashboard-ui.mjs
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "web");
const uiDir = path.join(root, "dashboard-ui");
const gobinDir = path.join(uiDir, ".gobin");
const goWinres = path.join(gobinDir, "go-winres.exe");

function run(cmd, cwd, env = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

// 0. ensure go-winres is available
if (!fs.existsSync(goWinres)) {
  console.log("installing go-winres into .gobin …");
  run(`go install github.com/tc-hib/go-winres@latest`, root, { GOBIN: gobinDir });
}

// 1. build the standalone server (default .next distDir keeps server.js clean)
run("npm run build", webDir, { WEB_STANDALONE: "1" });

const standalone = path.join(webDir, ".next", "standalone");

// 2. Next does not copy .next/static into standalone — do it here.
// dereference: the standalone tree contains symlinks (e.g. playwright-core)
// that Windows can't re-create without privileges — copy their targets instead.
fs.cpSync(path.join(webDir, ".next", "static"), path.join(standalone, ".next", "static"), {
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
fs.cpSync(standalone, path.join(uiDir, "app"), {
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
fs.writeFileSync(path.join(uiDir, "app", "build-info.json"), JSON.stringify({ sha: buildSha, builtAt, cacheVersion }, null, 2));

// 6. regenerate the Windows resources (icon + manifest + version) as .syso.
run(`${goWinres} make --arch amd64`, uiDir);

// 7. compile the GUI launcher (no console window) into the repo root.
// cacheVersion is injected, not a constant: the runtime dir becomes
// .dashboard-runtime\v<sha>, so a new build can never reuse a stale extraction.
run(`go build -ldflags "-H windowsgui -X main.cacheVersion=${cacheVersion}" -o ..\\career-dashboard-ui.exe .`, uiDir);

const out = path.join(root, "career-dashboard-ui.exe");
const mb = (fs.statSync(out).size / (1024 * 1024)).toFixed(1);
console.log(`\n✓ ${out} (${mb} MB)`);
