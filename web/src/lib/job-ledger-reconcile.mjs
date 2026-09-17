// Zombie-card ledger reconciliation (ADR-0031).
//
// WHY THIS EXISTS: a job card whose /api/events terminal event was missed
// (tab disconnect / sleep / dropped replay) stays "running" forever, and the
// /jobs "card wins" merge then shadows the server run-ledger's TERMINATED
// record — the #27 checkup (2026-09-16) ran 88 seconds, errored honestly via
// the ADR-0030 gate, and still spun for 30+ minutes on screen.
//
// THE RULE: a card that (a) claims running/queued — or is a restored card that
// was GUESS-marked interrupted (status "error" + `interruptedAt`, set by
// job-store's localStorage restore, indistinguishable from a real error
// without the marker) — plus (b) holds a runId, and (c) whose runId appears in
// the ledger with a terminal record that settled at least `graceMs` ago, IS
// stale: the ledger wins. The ledger only ever records TERMINATED runs
// (run-ledger.mjs), so "card claims active + ledger says terminal" can only
// mean the card is out of date.
//
// WHY A GRACE WINDOW INSTEAD OF AN isLive SKIP (2026-09-17 amendment, #73):
// v1 skipped cards whose event accumulator was still present, assuming a
// connected channel always delivers the terminal event. It doesn't — if the
// SSE channel drops right at settle, the reconnect replay only covers LIVE
// runs, the settled run's done/error event is lost forever, and the orphaned
// accumulator then blocks reconciliation indefinitely. The live path delivers
// within ~1s of settle, so a grace window (default 30s) never races it.
//
// Plain .mjs (same pattern as run-ledger.mjs): unit-tested with node --test,
// no TypeScript build step. `now` and `graceMs` are injected for purity.

/**
 * Reconcile local job cards against the server run ledger.
 * @param {Array<{id: string, runId?: string, status: string, interruptedAt?: number, steps: Array<{kind: string, label: string, ts: number}>, text: string, endedAt?: number, [k: string]: unknown}>} jobs
 * @param {Array<{id: string, status: "done"|"error", finishedAt: number, msg?: string}>} ledgerRuns
 *        — as produced by readRunHistory(): newest first.
 * @param {{now: number, graceMs?: number, doneLabel: string, errorLabel: string}} opts
 * @returns {{jobs: Array, healed: string[]}} — healed = ids of cured zombie cards.
 *          Unchanged cards pass through by identity so React sees minimal churn.
 */
export function reconcileJobsWithLedger(jobs, ledgerRuns, { now, graceMs = 30000, doneLabel, errorLabel }) {
  // Newest-first array: the FIRST record per run id is the authoritative one.
  const byRunId = new Map();
  for (const rec of ledgerRuns) {
    if (rec && rec.id && (rec.status === "done" || rec.status === "error") && !byRunId.has(rec.id)) {
      byRunId.set(rec.id, rec);
    }
  }

  let changed = false;
  const healed = [];
  const out = jobs.map((j) => {
    const isStale =
      j.status === "running" || j.status === "queued" || (j.status === "error" && j.interruptedAt != null);
    if (!j.runId || !isStale) return j;
    const rec = byRunId.get(j.runId);
    // Fresh record: give the live SSE path its race window first.
    if (!rec || now - rec.finishedAt < graceMs) return j;
    const isError = rec.status === "error";
    const label = isError ? (rec.msg || errorLabel) : doneLabel;
    healed.push(j.id);
    changed = true;
    return {
      ...j,
      status: rec.status,
      endedAt: rec.finishedAt,
      interruptedAt: undefined, // cured — the guess is replaced by the ledger's truth
      text: isError && rec.msg ? rec.msg : j.text,
      steps: [...(j.steps || []), { kind: "status", label, ts: now }],
    };
  });
  return { jobs: changed ? out : jobs, healed };
}
