// Server-wide visibility snapshot for the web worker list.
//
// The global CLI-concurrency pool (concurrency-pool.ts) is now the single
// authority on every in-flight evaluation — web single-run, in-app batch, and
// the BOSS直聘 browser extension all go through it because they share this one
// Node process. This module is a thin facade so `active-runs` keeps a stable
// import path: it just exposes the pool's {running, queued} snapshot. The
// queued half is what lets a worker stuck behind a full pool show as "排队中"
// (and be cancelled) instead of pretending it is running.
//
// Not persisted; a restart clears the pool (ADR-0014 Q8) — fine, the headless
// CLIs aren't in this process anyway.

import { listPool } from "@/lib/core/concurrency-pool";

/** Snapshot for /api/active-runs: `{running, queued}` tasks server-wide. */
export function listActiveRuns(): {
  running: ReturnType<typeof listPool>["running"];
  queued: ReturnType<typeof listPool>["queued"];
} {
  return listPool();
}