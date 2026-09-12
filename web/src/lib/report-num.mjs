// Which report does a worker reference? (ADR-0018)
//
// Plain .mjs like eval-timings.mjs / eval-timing-key.mjs so a node --test suite
// can lock the contract (web/tests/lib/report-num.test.mjs).
//
// A worker's report number has FOUR sources, asked in this order:
//
//   1. `reportNum` — captured at launch (pdf). Authoritative: it answers "which
//      report does THIS worker reference", and a later re-evaluation elsewhere
//      does not move it (reports/{NNN}-*.md is immutable).
//   2. `input` as an http(s) posting URL → the /api/report-status index → the
//      tracker row that posting was evaluated into. That answers a DIFFERENT
//      question — "which report did this posting become" — and it DOES follow a
//      re-evaluation's new number (ADR-0017 §4).
//   3. `subtitle` of the form `#N` — what the server's pool cards carry
//      (job-store.tsx). No local record and no URL: the subtitle is the only key.
//   4. Derived: a pdf worker's `input` IS its report number — the fallback for
//      records persisted before (1) existed (localStorage keeps 40).
//
// The number is for NAVIGATION only. It must never be read as "this worker's
// 评估用时" — that is the evaluation's metric, scoped to the evaluation kinds
// below (ADR-0018; the duration scope itself is ADR-0016).
import { normalizeUrl } from "./core/url-key.mjs";

const EVAL_KINDS = new Set(["evaluate", "batch-evaluate"]);
const NUMERIC = /^\d+$/;

/** Does this worker's card show 评估用时? Only evaluations have one: a report
 *  number resolved for navigation is not a duration claim. Records with no
 *  `kind` predate the field — keep their old behaviour. */
export function showsEvalDuration(job) {
  if (!job || !job.kind) return true;
  return EVAL_KINDS.has(job.kind);
}

/** The report number a worker references, or null. `reports` is the
 *  /api/report-status index (normalizeUrl(posting URL) → { reportNum }); pass
 *  null while it is still loading — the URL source then simply doesn't answer
 *  and resolution falls through to the next source. */
export function resolveJobReportNum(job, reports) {
  if (!job) return null;

  const captured = String(job.reportNum ?? "").trim();
  if (NUMERIC.test(captured)) return captured;

  const input = typeof job.input === "string" ? job.input : "";
  if (/^https?:\/\//i.test(input) && reports) {
    const key = normalizeUrl(input);
    const num = key ? reports[key]?.reportNum : null;
    if (num) return String(num);
  }

  const sub = typeof job.subtitle === "string" ? job.subtitle.match(/^#(\d+)$/) : null;
  if (sub) return sub[1];

  // Derived pdf fallback: `input` means a company name / a target / a URL for
  // every other kind, so this never generalizes beyond pdf.
  const trimmed = input.trim();
  if (job.kind === "pdf" && NUMERIC.test(trimmed)) return trimmed;

  return null;
}
