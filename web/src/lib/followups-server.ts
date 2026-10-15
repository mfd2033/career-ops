import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { withFollowupsLock, FollowupsBusyError } from "@/lib/core/followups-lock";
import { parseCadenceStdout } from "@/lib/followup-cadence-read.mjs";
import type { CadenceEntry } from "@/lib/followups";

export { FollowupsBusyError };

// Server-only helpers shared by the follow-ups API routes (log + override).

/** data/follow-ups.md — the follow-up log + next-date pins (user layer). */
export function followupsLogPath(): string {
  return path.join(careerOpsRoot(), "data", "follow-ups.md");
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
