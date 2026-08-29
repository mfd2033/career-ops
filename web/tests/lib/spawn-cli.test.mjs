// Tests for spawnHeadlessCli() using Node's built-in test runner.
// Imports directly from spawn-cli.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/spawn-cli.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteCliSpawn, spawnHeadlessCli } from "../../src/lib/spawn-cli.mjs";

test("spawnHeadlessCli closes stdin so a headless CLI can start", async () => {
  // Given: a child that only speaks once its stdin has reached EOF — a stand-in
  // for `codex exec`, which waits on an open stdin pipe for more prompt input
  // and so produces no stdout at all until it is closed (#2085).
  const script = [
    'process.stdin.on("end", () => process.stdout.write("READY"));',
    "process.stdin.resume();",
  ].join("");

  // When: it is spawned through the shared headless spawner.
  const child = spawnHeadlessCli(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: process.env,
  });

  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });

  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // If stdin regressed and stayed open, fail fast with a clear message instead
  // of hanging until the test runner's own timeout.
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("child did not close — stdin may not have been closed")), 3000);
  });

  const code = await Promise.race([closed, timedOut]);
  clearTimeout(timer); // don't keep node --test alive 3s after a clean close

  // Then: it saw EOF, spoke, and exited cleanly.
  assert.equal(code, 0);
  assert.equal(stdout, "READY");
});

test("spawnHeadlessCli tolerates a caller that passes stdio itself", async () => {
  // Given: no call site spells stdio today — the typed options omit it so
  // stdout/stderr stay non-null pipes. But an untyped or future caller could
  // pass stdio: ["ignore", …], which makes child.stdin null, and a hard
  // .end() would then throw. This pins the optional call that prevents it.
  const child = spawnHeadlessCli(process.execPath, ["-e", 'process.stdout.write("OK")'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // When: the child runs to completion.
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  // Then: no stdin pipe existed, and the run still succeeded.
  assert.equal(child.stdin, null);
  assert.equal(code, 0);
  assert.equal(stdout, "OK");
});

// rewriteCliSpawn exists because a Windows npm global install lays down three
// files for one `bin`, only one of which is executable without help:
// a POSIX shim (bare name, spawn → ENOENT), a `.cmd` launcher (spawn direct →
// EINVAL on Node < 22.9), and a `.ps1`. The `.cmd` must run through
// cmd.exe /d /s /c with args kept as separate argv entries so cmd metacharacters
// in a prompt (`&`, `|`, `<`, `>`) are quoted by CreateProcess, not interpreted
// by the shell. Testing via the injected `platform` argument keeps these
// assertions stable on every OS.

test("rewriteCliSpawn leaves POSIX paths untouched", () => {
  const out = rewriteCliSpawn("/usr/local/bin/claude", ["-p", "hi"], "linux");
  assert.deepEqual(out, { file: "/usr/local/bin/claude", args: ["-p", "hi"] });
});

test("rewriteCliSpawn leaves non-cmd Windows executables untouched", () => {
  const out = rewriteCliSpawn("C:\\tools\\claude.exe", ["-p", "hi"], "win32");
  assert.deepEqual(out, { file: "C:\\tools\\claude.exe", args: ["-p", "hi"] });
});

test("rewriteCliSpawn wraps .cmd/.bat through cmd.exe with args as separate argv", () => {
  const comspec = process.env.ComSpec || "cmd.exe";
  const out = rewriteCliSpawn("D:\\node_global\\opencode.cmd", ["run", "prompt & | < >"], "win32");
  assert.equal(out.file, comspec);
  assert.deepEqual(out.args, ["/d", "/s", "/c", "D:\\node_global\\opencode.cmd", "run", "prompt & | < >"]);
});

test("rewriteCliSpawn treats .BAT case-insensitively", () => {
  const comspec = process.env.ComSpec || "cmd.exe";
  const out = rewriteCliSpawn("C:\\x\\run.BAT", ["a"], "win32");
  assert.equal(out.file, comspec);
  assert.deepEqual(out.args, ["/d", "/s", "/c", "C:\\x\\run.BAT", "a"]);
});
