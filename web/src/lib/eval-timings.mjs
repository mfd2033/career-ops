// Pure parser + session model for data/eval-timings.tsv (耗时埋点, user-layer).
//
// Domain terms (CONTEXT.md): an 评估会话 (eval session) is the group of step
// rows a single evaluation produced for one report; a new session starts at an
// `extract` row (re-eval restarts the step ladder; liveness always follows
// extract and never starts a session — treating it as a start marker would
// split every normal session in two). Rows before the first extract (legacy
// runs like 703, or interrupted ones) form their own leading session. The
// 评估用时 (eval duration, ADR-0016) is the latest session's sum over the
// REPORT-DELIVERY steps only (extract/liveness/eval/report) — delayed
// pdf/answers/tracker rows (PDF 延后, ADR-0009) join their session's breakdown
// but are never counted. Orphan rows with no report-delivery step (a lone
// delayed `pdf`) yield duration null.
//
// Plain .mjs like pipeline-order.mjs so a node --test suite can lock the
// contract (web/tests/lib/eval-timings.test.mjs).

const DURATION_STEPS = new Set(["extract", "liveness", "eval", "report"]);
const SESSION_START_STEPS = new Set(["extract"]);

/** Parse the TSV body into rows. Tolerant: skips blanks/#comments (the header
 *  line is a `#` comment), short/malformed lines, and non-numeric seconds. */
export function parseEvalTimings(text) {
  const rows = [];
  if (!text) return rows;
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const cols = t.split("\t");
    if (cols.length < 3) continue;
    const seconds = Number.parseFloat(cols[2]);
    if (!Number.isFinite(seconds)) continue;
    rows.push({
      report: cols[0].trim(),
      step: cols[1].trim(),
      seconds,
      finishedAt: (cols[3] ?? "").trim(),
    });
  }
  return rows;
}

/** Split one report's rows (any order) into chronological sessions: a session
 *  starts at an `extract` row; rows before the first extract (legacy or
 *  interrupted runs) form their own leading session. */
export function splitSessions(rows) {
  const sorted = [...rows].sort((a, b) => (a.finishedAt || "").localeCompare(b.finishedAt || ""));
  const sessions = [];
  let cur = null;
  for (const r of sorted) {
    if (!cur || SESSION_START_STEPS.has(r.step)) {
      cur = [];
      sessions.push(cur);
    }
    cur.push(r);
  }
  return sessions;
}

/** Latest eval session for every report: Map report →
 *  { duration, steps, finishedAt }. "Latest" means the newest session that
 *  contains at least one report-delivery step — a delayed `pdf` trailing a
 *  finished session (PDF 延后) must not mask the real session before it. */
export function latestEvalSessions(rows) {
  const byReport = new Map();
  for (const r of rows) {
    if (!byReport.has(r.report)) byReport.set(r.report, []);
    byReport.get(r.report).push(r);
  }
  const out = new Map();
  for (const [report, rs] of byReport) {
    const sessions = splitSessions(rs);
    // newest session that actually evaluated (orphan pdf-only → fall back)
    let latest = null;
    for (let i = sessions.length - 1; i >= 0; i--) {
      if (sessions[i].some((r) => DURATION_STEPS.has(r.step))) {
        latest = sessions[i];
        break;
      }
    }
    if (!latest) {
      out.set(report, { duration: null, steps: [], finishedAt: null });
      continue;
    }
    const counted = latest.filter((r) => DURATION_STEPS.has(r.step));
    const sum = counted.reduce((s, r) => s + r.seconds, 0);
    out.set(report, {
      duration: Math.round(sum * 10) / 10,
      steps: latest.map((r) => ({ step: r.step, seconds: r.seconds })),
      finishedAt: latest[latest.length - 1]?.finishedAt || null,
    });
  }
  return out;
}

/** One-shot: TSV text → plain object keyed by report number (the shape both
 *  the /api/eval-durations route and the pipeline page consume). */
export function evalTimingSummary(text) {
  const map = {};
  for (const [report, entry] of latestEvalSessions(parseEvalTimings(text))) {
    map[report] = entry;
  }
  return map;
}
