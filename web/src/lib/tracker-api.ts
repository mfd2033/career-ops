import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { createQueryCache } from "@/lib/query-cache.mjs";
import {
  boundedLockWait,
  failureBody,
  httpStatusFor,
  parseCliJson,
  parseCliJsonArray,
  runCoreCli,
} from "@/lib/tracker-cli.mjs";

/**
 * Server-side plumbing shared by the /api/tracker routes.
 *
 * Every route here is a TRANSLATOR, never a writer: it validates the request,
 * spawns the core CLI named in `rootScripts`, and maps the CLI's exit code onto
 * an HTTP status. The tracker file is only ever touched by those CLIs, under
 * their shared lock — that is the invariant the whole surface exists to keep
 * (a route that reads and rewrites data/applications.md re-introduces the lost
 * update #2900 was about).
 */

/** Hard kill for one child run. Generous: a creating write waits on the lock. */
export const TRACKER_TIMEOUT_MS = 30_000;

/**
 * `data/applications.md` 的签名（mtimeMs+size）。
 *
 * ADR-0098 决议 4：tracker 行的**一切**变化都从这里出发——只读查询的结果只取决于
 * 这个文件（子进程的 SQLite 索引是它的派生物，会自动再同步）。文件没变就不必再
 * spawn 一个 Node 子进程（实测 411ms/次）；变了就整代作废，不靠谁记得刷新。
 *
 * @returns 签名串；文件不存在时返回 "-"（fresh checkout 也要能答）
 */
async function applicationsSignature(): Promise<string> {
  try {
    const st = await fs.promises.stat(path.join(careerOpsRoot(), "data", "applications.md"));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

// 只缓存「成功且带 rows 文档」的查询结果：超时、非零退出、spawn 失败都是环境
// 状态，不是「文件没变」的结论（ADR-0098 决议 4 —— 失败不进缓存）。
const queryCache = createQueryCache({
  signatureOf: applicationsSignature,
  isCacheable: (run: CliOutcome) => run.status === 200 && Array.isArray(run.rows),
});

/**
 * 跑一次只读查询，能复用就复用、能合流就合流（ADR-0098 决议 5）。
 *
 * @param key - 输入的身份（argv 拼成的稳定串）
 * @param run - 真正 spawn 子进程的那次调用
 * @returns 那次 run 的结果（可能来自缓存或别人在飞的那一个）
 */
export function runCachedTrackerQuery(key: string, run: () => Promise<CliOutcome>): Promise<CliOutcome> {
  return queryCache.get(key, run);
}

/** 写路径后主动作废（签名本来也会变，这一步只是让下一次读不必等一次 stat）。 */
export function invalidateTrackerQueries(): void {
  queryCache.invalidate();
}

/** One finished CLI run, with the parts the routes actually branch on. */
export type CliOutcome = {
  code: number;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
  timedOut: boolean;
  /** The CLI's JSON object document, when it printed one. */
  parsed: Record<string, unknown> | null;
  /** The CLI's JSON array document, when that is what it printed (query). */
  rows: Record<string, unknown>[] | null;
  /** `code` from the CLI's own document — the field exit codes are too coarse for. */
  cliCode: string | null;
  /** HTTP status this run maps to; 200 when it succeeded. */
  status: number;
};

/**
 * Whether the core script exists in this checkout.
 *
 * The web can run against a CAREER_OPS_ROOT that holds data and no scripts.
 * "Spawn it and see" is not an answer there: the child's failure is a Node
 * module-resolution stack trace, useless to the caller and an absolute-path
 * disclosure if echoed. Same feature-detection /api/status and /api/followups
 * already use.
 *
 * @param nameNoExt - Script name without the .mjs extension.
 * @returns True when the script is present.
 */
export function coreScriptAvailable(nameNoExt: string): boolean {
  try {
    return fs.existsSync(rootScript(nameNoExt));
  } catch {
    return false;
  }
}

/**
 * The 503 body for a root that has data but no scripts to write it with.
 *
 * @returns A NextResponse, ready to return.
 */
export function coreScriptMissing(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "core-script-missing",
        message: "tracker writes need the career-ops scripts; this root has data only",
      },
      retryable: false,
    },
    { status: 503 },
  );
}

/**
 * Run one core CLI and decode whatever it printed.
 *
 * @param nameNoExt - Script name without the .mjs extension (e.g. "tracker-add").
 * @param args - Arguments after the script path.
 * @param options.timeoutMs - Hard kill, defaulting to TRACKER_TIMEOUT_MS.
 * @returns The run, including the HTTP status it maps to.
 */
export async function runTrackerScript(
  nameNoExt: string,
  args: string[],
  { timeoutMs = TRACKER_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<CliOutcome> {
  const run = await runCoreCli({
    scriptPath: rootScript(nameNoExt),
    args,
    cwd: careerOpsRoot(),
    timeoutMs,
    env: boundedLockWait(timeoutMs),
  });
  // 写路径成功 → 立刻作废查询缓存（ADR-0098 决议 5）。判据是 argv 的子命令而不是
  // 脚本名：同一个 `tracker.mjs` 既能 `query` 也能 `sync`/`delete`，按脚本名判断
  // 会把写漏掉，而那正是用户最在乎的那次刷新。
  if (run.code === 0 && args[0] !== "query") invalidateTrackerQueries();
  const parsed = parseCliJson(run.stdout);
  // query prints a bare array of row objects. Narrow it here rather than
  // claiming at the call site: the document arrives from a child process, so
  // "it is an array" is all the parser can honestly promise.
  const printed = parseCliJsonArray(run.stdout);
  const rows = printed
    ? printed.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    : null;
  const cliCode = typeof parsed?.code === "string" ? parsed.code : null;
  const status = run.code === 0
    ? 200
    : httpStatusFor({
      exitCode: run.code,
      cliCode,
      spawnFailed: run.spawnFailed,
      timedOut: run.timedOut,
    });
  return { ...run, parsed, rows, cliCode, status };
}

/**
 * Log a run the caller is not going to see, then return nothing.
 *
 * Child stderr belongs in the server log, never in a response body: on the crash
 * path it is a Node stack trace carrying absolute server paths.
 *
 * @param route - Route label for the log line.
 * @param run - The finished run.
 */
export function logRunFailure(route: string, run: CliOutcome): void {
  if (!run.stderr.trim()) return;
  const detail = run.parsed ? "" : " without JSON";
  console.error(`/api/tracker${route}: ${run.spawnFailed ? "failed to run" : `exited ${run.code}`}${detail}: ${run.stderr.trim()}`);
}

/**
 * Build the failure response for a run whose exit code was non-zero.
 *
 * @param route - Route label for the server log.
 * @param run - The finished run.
 * @returns A NextResponse carrying this surface's error envelope.
 */
export function failResponse(route: string, run: CliOutcome): NextResponse {
  logRunFailure(route, run);
  const body = failureBody({
    parsed: run.parsed,
    cliCode: run.cliCode,
    exitCode: run.code,
    spawnFailed: run.spawnFailed,
    timedOut: run.timedOut,
  });
  const headers: Record<string, string> = run.status === 503 || run.status === 504
    ? { "Retry-After": "5" }
    : {};
  return NextResponse.json(body, { status: run.status, headers });
}

/**
 * Build the success envelope: `{ok: true, data}` plus any extra top-level keys.
 *
 * @param data - The payload.
 * @param extra - Additional envelope keys (e.g. `retryable` from a health probe).
 * @returns A 200 NextResponse.
 */
export function okResponse(data: unknown, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: true, data, ...extra });
}

/**
 * The error envelope for a request this surface refuses (or a missing row).
 *
 * One builder for every non-CLI failure keeps the envelope shape in one place:
 * `{ok: false, error: {code, message}, retryable}`.
 *
 * @param status - HTTP status.
 * @param code - Machine-readable reason.
 * @param message - What was wrong, specific enough to fix.
 * @returns A NextResponse carrying the error envelope.
 */
export function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message }, retryable: status === 503 || status === 504 },
    { status },
  );
}

/**
 * The 400 body for a request this surface refuses before spawning anything.
 *
 * @param code - Machine-readable reason (usage / invalid-field / invalid-state).
 * @param message - What was wrong, specific enough to fix.
 * @returns A 400 NextResponse.
 */
export function badRequest(code: string, message: string): NextResponse {
  return errorResponse(400, code, message);
}

/**
 * The 404 body for a row that does not exist.
 *
 * Answered by the route rather than by the CLI: `tracker.mjs query --id N`
 * reports "no rows" as an empty array (its success path), so the not-found case
 * is only visible here.
 *
 * @param message - Which row was asked for.
 * @returns A 404 NextResponse.
 */
export function notFound(message: string): NextResponse {
  return errorResponse(404, "not-found", message);
}
