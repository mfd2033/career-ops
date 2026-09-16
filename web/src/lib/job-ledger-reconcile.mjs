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
// without the marker) — plus (b) holds a runId, (c) has NO live event
// accumulator (isLive(id) === false — the SSE path can no longer deliver for
// it), and (d) whose runId appears in the ledger with a terminal status, IS
// stale: the ledger wins. The ledger only ever records TERMINATED runs
// (run-ledger.mjs), so "card claims active + ledger says terminal" can only
// mean the card is out of date — no false-positive surface.
//
// Plain .mjs (same pattern as run-ledger.mjs): unit-tested with node --test,
// no TypeScript build step. `isLive` and `now` are injected for purity.

/**
 * Reconcile local job cards against the server run ledger.
 * @param {Array<{id: string, runId?: string, status: string, interruptedAt?: number, steps: Array<{kind: string, label: string, ts: number}>, text: string, endedAt?: number, [k: string]: unknown}>} jobs
 * @param {Array<{id: string, status: "done"|"error", finishedAt: number, msg?: string}>} ledgerRuns
 *        — as produced by readRunHistory(): newest first.
 * @param {{isLive: (id: string) => boolean, now: number, doneLabel: string, errorLabel: string}} opts
 * @returns {{jobs: Array, healed: string[]}} — healed = ids of cured zombie cards.
 *          Unchanged cards pass through by identity so React sees minimal churn.
 */
export function reconcileJobsWithLedger(jobs, ledgerRuns, { isLive, now, doneLabel, errorLabel }) {
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
    if (isLive(j.id)) return j; // live SSE path owns this card's terminal state
    const rec = byRunId.get(j.runId);
    if (!rec) return j; // not settled yet (or never dispatched) — hands off
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
