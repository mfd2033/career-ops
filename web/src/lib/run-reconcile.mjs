/**
 * run-reconcile.mjs — what a single /api/run evaluate owes data/pipeline.md
 * (ADR-0051 决议 9/10).
 *
 * The batch orchestrator reserves a contiguous report-number range up front, so it
 * always knows which (num, url) pair each worker scored and can hand those pairs to
 * `reconcile-pipeline.mjs --entry` when the batch ends. A single run has no such
 * knowledge: the worker reserves its OWN number mid-run (step 2a), which is exactly
 * why ADR-0018 resolves a single run's report jump by joining the tracker on URL
 * instead of carrying the number. The consequence was a silently missing step — a
 * posting evaluated one at a time kept its `- [ ]` row in Pendientes and re-surfaced
 * in the inbox (the bug `inbox-triage.tsx` records for the batch path's precursor).
 *
 * So the route learns the number from the one artifact it can observe: what landed
 * in reports/ while the worker ran. Pure — no fs, no Next — so the refusal to guess
 * is assertable rather than emergent.
 */
import { completedReportNames } from "./run-cli-support.mjs";

/** Report numbers are 3+ digits, zero-padded by the allocator but historically
 *  unpadded in the wild (`1001-taken.md` is a real report name). */
const REPORT_NUM_RE = /^(\d{3,})-/;

/**
 * The report number this run persisted, or null when it cannot be established.
 *
 * Exactly one new completed report → that one. None → the run produced nothing
 * (its own honesty gate already says so). More than one → another evaluate run
 * landed its report inside this run's window, and attaching the wrong number to a
 * pipeline row is worse than leaving the row for `reconcile-pipeline.mjs
 * --from-tracker`, the script's own documented self-heal sweep.
 *
 * @param {{beforeEntries: string[], afterEntries: string[]}} args
 * @returns {number | null}
 */
export function deriveRunReportNum({ beforeEntries, afterEntries }) {
  const before = completedReportNames(beforeEntries ?? []);
  const after = completedReportNames(afterEntries ?? []);
  const candidates = [];
  for (const name of after) {
    if (before.has(name)) continue;
    const m = REPORT_NUM_RE.exec(name);
    if (m) candidates.push(Number(m[1]));
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * The argv for `reconcile-pipeline.mjs`, or null when there is nothing to do.
 *
 * Only an evaluate run whose input IS a posting URL can be reconciled: pdf takes a
 * bare report number, checkup a tracker row number, fix-portal a company name —
 * moving an inbox row on any of those keys would move the wrong row.
 *
 * @param {{kind: string, input: string, num: number | null | undefined}} args
 * @returns {string[] | null}
 */
export function buildReconcileArgs({ kind, input, num }) {
  if (kind !== "evaluate") return null;
  if (num == null) return null;
  if (typeof input !== "string" || !/^https?:\/\//i.test(input)) return null;
  return ["--entry", `${num}|${input}`];
}
