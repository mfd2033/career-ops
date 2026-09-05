// In-memory registry of in-flight BATCH evaluations, server-wide.
//
// Why this exists: batch evaluations can be started from two independent
// surfaces — the in-app pipeline "re-evaluate" (via job-store's startJob →
// POST /api/batch-evaluate) and the BOSS直聘 browser extension (POSTs the same
// endpoint). Both are headless and stream NDJSON, but only the in-app path
// creates a "worker card". The extension's evaluations are invisible to the web
// UI's worker list because job-store's in-memory state can't be shared across
// processes. This module is the shared, cross-source record: the batch-evaluate
// route registers each in-flight URL here on dispatch and unregisters it when
// the worker settles, and /api/active-runs exposes a read-only snapshot the
// frontend polls so ANY in-flight evaluation — web or extension — shows up in
// the worker list.
//
// Single local Node process ⇒ a module-level Map is enough, same reasoning as
// run-registry.ts. Not persisted; a server restart loses in-flight visibility,
// which is fine (the headless CLIs aren't in this process anyway).
//
// The key is the RAW posting URL (not normalizeUrl'd): it's only used to match
// against frontend-supplied URLs 1:1 within this snapshot's lifetime, so
// keeping the exact string the caller passed avoids any normalize-drift between
// this registry and the frontend. Report number is optional (besides the URL, it
// gives the worker list something human-readable to show).

export type ActiveRun = {
  url: string; // raw posting URL, exactly as dispatched
  startedAt: number; // epoch ms when the worker began
  reportNum?: number; // the batch-reserved report number for this URL
  id: string; // stable handle so the frontend can key workers + dismiss an entry
};

let seq = 0;
const byUrl = new Map<string, ActiveRun>();

/** Register a URL as in-flight; returns the stable id. */
export function registerActiveRun(url: string, reportNum?: number): string {
  const id = `active-${++seq}`;
  byUrl.set(url, { url, startedAt: Date.now(), reportNum, id });
  return id;
}

/** Remove a URL from the in-flight set (no-op if unknown). */
export function unregisterActiveRun(url: string): void {
  byUrl.delete(url);
}

/** Snapshot of every in-flight batch evaluation. */
export function listActiveRuns(): ActiveRun[] {
  return Array.from(byUrl.values());
}