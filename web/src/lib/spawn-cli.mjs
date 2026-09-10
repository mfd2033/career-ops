import { spawn } from "node:child_process";
import { platform } from "node:os";

// Plain .mjs (same pattern as tracker-table.mjs/clean-chips.mjs) so
// tests/lib/spawn-cli.test.mjs can import it directly under Node. Import it with the
// .mjs extension included (e.g. "@/lib/spawn-cli.mjs") — unlike .ts files,
// which TypeScript resolves without an extension, ESM specifiers for plain
// JS modules must be fully specified.

/**
 * Spawn a headless agent CLI with stdin closed.
 *
 * CLIs such as `codex exec` read additional prompt text from stdin when a pipe
 * is left open. A web request never supplies that extra input, so leaving the
 * default pipe open makes Codex wait forever without producing stdout. This is
 * the ONLY spawn path for CLI-invoking routes — every call site should use it
 * instead of `node:child_process`'s `spawn` directly, so the fix can't drift.
 *
 * It also replaces the `stdio: ["ignore", ...]` the apply planners used to spell
 * for the same reason — one mechanism means one place for this to be right.
 * The options type omits `stdio` on purpose: stdout/stderr must stay pipes for
 * every caller's stream handlers, and TypeScript keeps `child.stdout` non-null
 * only under that contract. `stdin` is still optional-chained so an untyped
 * caller passing `stdio` anyway degrades safely (null stdin) instead of throwing.
 *
 * The binPath must already be a DIRECTLY spawnable executable — clis.ts's
 * findBin() resolves the real native `.exe` on Windows (never a `.cmd`/`.bat`
 * shim or an extensionless POSIX script), because routing those through
 * `cmd.exe` would truncate a multi-line prompt at its first newline.
 *
 * @param {string} binPath
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptionsWithoutStdio} options
 */
export function spawnHeadlessCli(binPath, args, options) {
  // detached: true 让 CLI 成为独立进程组/session leader (POSIX)。
  // 终止时按进程组发信号才能连带杀掉 CLI 运行中派生的子进程。
  const child = spawn(binPath, args, { ...options, detached: true });
  child.stdin?.end();
  return child;
}

/**
 * 跨平台终止 CLI 进程树。
 *
 * 背景：Windows 上 child.kill("SIGTERM") 只终止直接子进程，CLI 在运行中
 * 派生的搜索/工具子进程不会随之退出，残留成孤儿进程持续占用 CPU ——
 * 页面刷新中断评估后曾观察到 13 个 Git find.exe 空转全盘扫描。终止必须
 * 按进程树进行：
 *   - Windows: taskkill /T /F 按 PID 递归终止整棵进程树。
 *   - POSIX: detached spawn 使 CLI 成为进程组 leader，负 PID 信号作用于
 *     整个进程组。
 * fire-and-forget（best-effort），失败静默忽略，与旧 kill 行为一致。
 */
export function terminateCli(child) {
  if (!child || typeof child.pid !== "number") return;
  try {
    if (platform() === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* 进程可能已自行退出，忽略 */
  }
}
