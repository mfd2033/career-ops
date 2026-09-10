// Tests for spawnHeadlessCli() using Node's built-in test runner.
// Imports directly from spawn-cli.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/spawn-cli.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnHeadlessCli, terminateCli } from "../../src/lib/spawn-cli.mjs";

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

test("terminateCli kills the whole process tree, not just the direct child", async () => {
  // 旧行为 (child.kill) 在 Windows 只杀直接子进程，CLI 派生的孙进程会残留成
  // 孤儿 —— 中断评估后曾观察到 13 个 Git find.exe 空转全盘扫描。terminateCli
  // 必须递归终止整棵进程树，此测试即该泄漏的回归防护。
  const script = [
    'const { spawn } = require("node:child_process");',
    'const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });',
    'process.stdout.write("SPAWNED:" + g.pid + "\\n");',
    "setInterval(()=>{},1000);",
  ].join(" ");
  const child = spawnHeadlessCli(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: process.env,
  });

  // 读取孙进程 PID
  let grandchildPid = 0;
  const gotPid = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      const m = String(chunk).match(/SPAWNED:(\d+)/);
      if (m) {
        grandchildPid = parseInt(m[1], 10);
        resolve();
      }
    });
  });
  await gotPid;
  assert.ok(grandchildPid > 0, "grandchild spawned");

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  try {
    terminateCli(child);

    // taskkill / 进程组信号是异步的，轮询等待整树退出
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (alive(child.pid) || alive(grandchildPid))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(alive(child.pid), false, "direct child terminated");
    assert.equal(alive(grandchildPid), false, "grandchild terminated — process tree killed");
  } finally {
    // 断言失败时兜底清理，避免测试残留孤儿进程
    for (const pid of [child.pid, grandchildPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
});


