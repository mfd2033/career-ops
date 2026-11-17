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
//   4. Derived, for the numeric-input kinds only (ADR-0089): a pdf worker's
//      `input` IS its report number (the fallback for records persisted before
//      (1) existed — localStorage keeps 40), and a checkup's `input` IS its
//      tracker row #, which is the same number as its report.
//
// The number is for NAVIGATION only. It must never be read as "this worker's
// 评估用时" — that is the evaluation's metric, scoped to the evaluation kinds
// below (ADR-0018; the duration scope itself is ADR-0016).
import { normalizeUrl } from "./core/url-key.mjs";

const EVAL_KINDS = new Set(["evaluate", "batch-evaluate"]);
const NUMERIC = /^\d+$/;

// Kinds whose `input` IS the report number, per each kind's own launch contract
// (ADR-0089): pdf captures the bare number, and a checkup's input is the tracker
// row # — the same number as its report (applications.md's first column is the
// report filename's prefix, and the /report/{n} route). A CLOSED whitelist on
// purpose: ADR-0018 rejected generalising this, because every other kind's input
// means a URL / company / target, and a future kind reusing a numeric input must
// not silently mis-jump.
const NUMERIC_INPUT_KINDS = new Set(["pdf", "checkup"]);

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
  // 失败卡（含用户中断）不走「职位 URL → 索引」这条回退：那个索引回答的是
  // 「这份职位后来变成哪份报告」，不是「本 run 写了什么」。2026-11-17 的
  // 杰尔古格失败卡因此挂上了 20 分钟后重跑成功的 #1344，看起来像失败也有产物。
  // 捕获号与池卡 `#N` 不动——pdf/checkup 的失败卡仍指向自己启动时引用的报告。
  const failed = job.status === "error";
  if (!failed && /^https?:\/\//i.test(input) && reports) {
    const key = normalizeUrl(input);
    const num = key ? reports[key]?.reportNum : null;
    if (num) return String(num);
  }

  const sub = typeof job.subtitle === "string" ? job.subtitle.match(/^#(\d+)$/) : null;
  if (sub) return sub[1];

  // Derived fallback for the numeric-input kinds (ADR-0089): pdf's `input` is the
  // captured bare number; a checkup's is its tracker row #. For every other kind
  // `input` means a company name / a target / a URL, so this stays whitelisted.
  // batch-checkup's aggregate input is a "#n +k" summary, never one number — its
  // per-company numbers live on the child items (ADR-0046 §3), not here.
  const trimmed = input.trim();
  if (NUMERIC_INPUT_KINDS.has(job.kind) && NUMERIC.test(trimmed)) return trimmed;

  return null;
}
