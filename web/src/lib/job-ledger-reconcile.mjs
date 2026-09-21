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

import { clipStepLabel } from "./run-steps.mjs";

/**
 * Reconcile local job cards against the server run ledger.
 * @param {Array<{id: string, runId?: string, status: string, interruptedAt?: number, steps: Array<{kind: string, label: string, ts: number}>, text: string, endedAt?: number, [k: string]: unknown}>} jobs
 * @param {Array<{id: string, status: "done"|"error", finishedAt: number, msg?: string, steps?: Array<{kind: string, label: string, ts?: number}>}>} ledgerRuns
 *        — as produced by readRunHistory(): newest first. ADR-0047: a single-run
 *        record may carry a durable `steps` reconstruction; pre-feature records don't.
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
      // ADR-0047 决议 4：台账带 durable `steps` 时据此重建时间线（本地卡跑时页签
      // 不在线，中间逐工具步骤此前永久丢失，只剩种子 + Done 两行）；旧记录无
      // steps 时逐字节回落旧行为（只 append 终态）。
      steps: mergeHealedSteps(j.steps, rec.steps, { kind: "status", label, ts: now }),
    };
  });
  return { jobs: changed ? out : jobs, healed };
}

/**
 * Merge a card's local steps with the ledger's durable step reconstruction, then
 * append the terminal row. The ledger `steps` is the authoritative reconstruction
 * folded at terminal time from the FULL server buffer, so it is a superset of
 * what a partially-live tab received (the tab only ever holds what the server
 * sent it). Hence: keep local-only rows first (the client seed 「正在启动…」 and
 * any restore guess — rows the server never emitted), then the ENTIRE
 * reconstruction in its own order (preserving genuine repeated tool calls), then
 * the terminal row. A local row that the reconstruction already carries is
 * dropped, deduped by `kind:clip(label)` — clipped on both sides so a long
 * label (client keeps it full, ledger clipped to 200) still matches, and NOT by
 * ts (client receive-time vs server wall clock differ for the same step). When
 * the record has no `steps` (pre-feature ledger), this is byte-for-byte the old
 * behaviour: local steps + terminal row.
 * @param {Array<{kind: string, label: string, ts?: number}>} localSteps
 * @param {Array<{kind: string, label: string, ts?: number}> | undefined} recSteps
 * @param {{kind: string, label: string, ts: number}} terminalRow
 * @returns {Array<{kind: string, label: string, ts?: number}>}
 */
function mergeHealedSteps(localSteps, recSteps, terminalRow) {
  const local = Array.isArray(localSteps) ? localSteps : [];
  const rec = Array.isArray(recSteps) ? recSteps.filter((s) => s && typeof s.label === "string") : [];
  if (rec.length === 0) {
    return [...local, terminalRow];
  }
  const normKey = (s) => `${s.kind}:${clipStepLabel(s.label)}`;
  const recKeys = new Set(rec.map(normKey));
  const out = [];
  // Local-only rows first (seed / restore guess); skip anything the ledger carries.
  for (const s of local) {
    if (!s || typeof s.label !== "string") continue;
    if (recKeys.has(normKey(s))) continue;
    out.push(s);
  }
  // Full reconstruction, own order, genuine repeats preserved (no self-dedup).
  for (const s of rec) out.push(s);
  out.push(terminalRow);
  return out;
}
