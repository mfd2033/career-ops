import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findApplication, readApplicationUrl, rootScript } from "@/lib/career-ops";
import { withFollowupsLock, FollowupsBusyError } from "@/lib/core/followups-lock";
import { parseCadenceStdout } from "@/lib/followup-cadence-read.mjs";
import { parseScripts, fillScripts, groupOrder } from "@/lib/followup-scripts.mjs";
import type { CadenceEntry } from "@/lib/followups";

export { FollowupsBusyError };

// Server-only helpers shared by the follow-ups API routes (log + override).

/** data/follow-ups.md — the follow-up log + next-date pins (user layer). */
export function followupsLogPath(): string {
  return path.join(careerOpsRoot(), "data", "follow-ups.md");
}

/** templates/followup-scripts.md — 跟进话术模板库（ADR-0080）。实体是用户个人资产
 *  （话术是他自己的口径），只是路径落在 templates/ 下；不得被系统更新覆盖。 */
export function followupScriptsPath(): string {
  return path.join(careerOpsRoot(), "templates", "followup-scripts.md");
}

// In-process serialization of follow-up mutations: POST log derives the next
// num from a read of the file, DELETE and the override routes do read-modify-
// write — unserialized, concurrent requests in THIS process could mint
// duplicate nums or drop lines. The web app is a single local server process,
// so a promise queue serializes them.
//
// WHAT THIS DOES **NOT** PROTECT: this queue only sees THIS process. It cannot
// see the user's CLI or the core's cadence seeder (followup-seed.mjs), which
// read-modify-write the SAME data/follow-ups.md. Its old comment claimed "no
// cross-process lock needed", and that false comfort is exactly why the gap
// survived — a reader who sees a guard stops looking for the one that is
// missing (the same shape as /api/status before #2903). Cross-process exclusion
// is the core FILE lock, reached via withFollowupsLock; this queue and that
// lock COMPOSE (see withFollowupsWrite) — neither replaces the other.
let queue: Promise<unknown> = Promise.resolve();
export function withLogLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// The full guard for any data/follow-ups.md mutation. Order is load-bearing and
// agreed with the core maintainer (#3034): the in-process queue OUTSIDE, the
// cross-process file lock INSIDE.
//
//   withLogLock(() => withFollowupsLock(path, fn))
//
// Why this order: the queue reduces this process's N concurrent requests to ONE
// before the file lock is touched, so the file lock only ever arbitrates "the
// one active web request vs the user's CLI". Reversed, two of the user's own
// browser tabs would contend on the cross-process lock — one wins, the other
// eats the timeout and a 409 — for a race the free in-process queue already
// resolves. Every followups writer goes through here so no call site can get
// the nesting wrong.
export function withFollowupsWrite<T>(fn: () => T | Promise<T>): Promise<T> {
  return withLogLock(() => withFollowupsLock(followupsLogPath(), fn));
}

// Map a throw from withFollowupsWrite onto an HTTP response, consistently across
// the four followups mutation handlers. A contended lock is transient (someone
// else — the CLI, the seeder, another tab — holds it right now), so it is 409 +
// Retry-After, not a 500: the caller should retry, not treat the write as
// rejected. Anything else is a real failure on this machine → 500.
export function followupsWriteError(e: unknown, fallback = "write failed"): Response {
  if (e instanceof FollowupsBusyError) {
    return Response.json(
      { error: "follow-ups file is busy — try again in a moment" },
      { status: 409, headers: { "Retry-After": "1" } },
    );
  }
  return Response.json({ error: e instanceof Error ? e.message : fallback }, { status: 500 });
}

// ── Cadence verdicts（followup-cadence.mjs --json） ──────────────────────────
// The ONE reader of the cadence verdict: /api/followups and the report pages'
// 「记录跟进」entry (ADR-0075 决议 7) both come through here. Never throws —
// missing script / spawn failure / bad stdout collapse to available:false, and
// every caller fails closed (entry hidden, route reports unavailable).

const CADENCE_TIMEOUT_MS = 12_000;

export type CadencePayload = {
  available: boolean;
  metadata: unknown;
  entries: CadenceEntry[];
  cadenceConfig?: unknown;
};

export async function readCadencePayload(): Promise<CadencePayload> {
  const script = rootScript("followup-cadence");
  if (!fs.existsSync(script)) return { available: false, metadata: null, entries: [] };
  const stdout = await new Promise<string>((resolve) => {
    execFile("node", [script, "--json"], { cwd: careerOpsRoot(), timeout: CADENCE_TIMEOUT_MS }, (_e, out) => resolve(out || ""));
  });
  const parsed = parseCadenceStdout(stdout);
  if (!parsed) return { available: false, metadata: null, entries: [] };
  return {
    available: true,
    metadata: parsed.metadata,
    entries: parsed.entries as CadenceEntry[],
    cadenceConfig: parsed.cadenceConfig,
  };
}

/** 报告页「记录跟进」的读取（ADR-0075 决议 2/3）：本行的 cadence entry —— 可判定性
 *  与联系人建议在同一份同源输出里 —— 或 null（不可跟进 / core 不可用，fail-closed）。 */
export async function readFollowupEntry(id: string): Promise<CadenceEntry | null> {
  const num = Number.parseInt(id, 10);
  if (!Number.isInteger(num)) return null;
  const payload = await readCadencePayload();
  if (!payload.available) return null;
  return payload.entries.find((e) => e.num === num) ?? null;
}

// ── 跟进话术模板（templates/followup-scripts.md，ADR-0080）────────────────────
// 「生成话术」区块的读取：解析 + 按本行 cadence entry 填占位符。只读，无锁——
// 复制走剪贴板、不落任何文件，所以这里是唯一一条不碰 data/ 的 followups 路径。

export type FollowupScriptLine = { label: string; text: string };

export type FollowupScript = {
  name: string;
  group: string;
  scenario: string;
  lines: FollowupScriptLine[];
  /** 取不到值的占位符（含 {城市}{原因}{时间} 这种无数据源的手填键），原样留在文本里。 */
  missing: string[];
};

export type FollowupScriptsPayload = {
  available: boolean;
  groups: string[];
  scripts: FollowupScript[];
  /** 本行报告头 `**URL:**` 的原始职位链接（仅 http(s) 才留，否则 null）——「打开职位」
   *  按钮外站打开的目标（ADR-0081）。报告缺失 / 非 http(s) / 行不存在 → null（按钮置灰）。 */
  postingUrl: string | null;
};

/** fail-closed：文件缺失 / 读失败 / 解析出零条 / 本行 entry 取不到 → available:false。
 *  最后一条最要紧——没有 entry 就没有 {投递日}{岗位名} 的值，只回一堆空模板等于
 *  给了个填不了的话术，不如让 UI 安静地说一句「暂不可用」。 */
export async function readFollowupScripts(row: CadenceEntry | null): Promise<FollowupScriptsPayload> {
  // 「打开职位」的目标（ADR-0081）：复用 readApplicationUrl —— 报告头 `**URL:**` 的
  // 单点提取（http(s)-only，非 http 返回 undefined），不另写一份报告头解析。行不存在
  // / 报告缺失 / 非 http(s) → null（按钮置灰）。
  const app = row ? findApplication(String(row.num)) : null;
  const postingUrl = app ? (readApplicationUrl(app) ?? null) : null;
  const empty: FollowupScriptsPayload = { available: false, groups: [], scripts: [], postingUrl };
  if (!row) return empty;
  const file = followupScriptsPath();
  if (!fs.existsSync(file)) return empty;
  let markdown: string;
  try {
    markdown = fs.readFileSync(file, "utf8");
  } catch {
    return empty;
  }
  const parsed = parseScripts(markdown);
  if (!parsed.length) return empty;
  return {
    available: true,
    groups: groupOrder(parsed) as string[],
    scripts: fillScripts(parsed, row) as FollowupScript[],
    postingUrl,
  };
}
