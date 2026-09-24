#!/usr/bin/env node
// build-dashboard-ui.mjs — package the career-ops web UI into the lightweight
// career-dashboard-launcher.exe (no embedded runtime; reads from .dashboard-runtime/).
//
// Pipeline:
//   1. next build (standalone output)   → web/.next/standalone
//   2. copy .next/static into the standalone tree (Next does not do this)
//   3. strip traced dev files (src/, tests/, logs, configs) out of standalone
//   4. copy the clean standalone tree  → dashboard-ui/app   (Go embed source)
//   5. copy the running node binary     → dashboard-ui/node.exe (Go embed source)
//   6. go-winres make                   → rsrc_windows_amd64.syso (icon + manifest)
//   7. go build -ldflags cacheVersion   → career-dashboard-launcher.exe (repo root)
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

// 6. regenerate the Windows resources (icon + manifest + version) as .syso.
run(`${goWinres} make --arch amd64`, uiDir);

// 7. Lightweight launcher (~9 MB): no embedded runtime, reads from cache dir.
// cacheVersion injection prevents the launcher falling back to newest-by-mtime
// and silently serving a stale .dashboard-runtime extraction after a rebuild.
{
  const out = path.join(root, "career-dashboard-launcher.exe");
  run(`go build -ldflags "-X main.cacheVersion=${cacheVersion}" -o ..\\career-dashboard-launcher.exe .`, uiDir);
  const mb = (fs.statSync(out).size / (1024 * 1024)).toFixed(1);
  console.log(`\n✓ ${out} (${mb} MB)`);
}
