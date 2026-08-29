import { spawn } from "node:child_process";

// Plain .mjs (same pattern as tracker-table.mjs/clean-chips.mjs) so
// tests/lib/spawn-cli.test.mjs can import it directly under Node. Import it with the
// .mjs extension included (e.g. "@/lib/spawn-cli.mjs") — unlike .ts files,
// which TypeScript resolves without an extension, ESM specifiers for plain
// JS modules must be fully specified.

/**
 * Windows: resolve how to actually start a CLI binary so the web routes don't
 * half-start it and report a bare "spawn ... ENOENT/EINVAL".
 *
 * On Windows an npm global install lays down three files for one `bin`:
 *   - `opencode`        — a POSIX shim (bash script), no extension. Windows
 *                         cannot execute it → `spawn ... ENOENT`.
 *   - `opencode.cmd`    — the real launcher, but `child_process.spawn` cannot
 *                         run a `.cmd`/`.bat` directly on Node < 22.9 (returns
 *                         EINVAL) — the no-shell support only landed in v22.9.
 *   - `opencode.ps1`    — PowerShell, not spawnable either.
 * The one reliable path is `cmd.exe /d /s /c <script> <args...>`, which is what
 * Node itself uses internally once it does support no-shell `.cmd` spawning.
 * Pass the script and args as SEPARATE argv entries: doing it with
 * `shell: true` instead hands a pre-joined string to cmd.exe, and a prompt
 * containing `&`, `|`, `<`, `>` then breaks — the metacharacters land outside
 * cmd.exe's own quoting and get interpreted as operators.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {string} [platform] test hook; defaults to process.platform
 * @returns {{ file: string, args: string[] }}
 */
export function rewriteCliSpawn(file, args, platform = process.platform) {
  if (platform !== "win32") return { file, args };
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args };
  const comspec = process.env.ComSpec || "cmd.exe";
  return { file: comspec, args: ["/d", "/s", "/c", file, ...args] };
}

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
 * @param {string} binPath
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptionsWithoutStdio} options
 */
export function spawnHeadlessCli(binPath, args, options) {
  const { file, args: argv } = rewriteCliSpawn(binPath, args);
  const child = spawn(file, argv, options);
  child.stdin?.end();
  return child;
}
