// Server-side run ledger (ADR-0027 follow-up, B4-class observability fix):
// `.career-ops-web/runs/index.jsonl` — one JSON line per TERMINATED run.
//
// WHY THIS EXISTS: /jobs history lives in browser localStorage (job-store),
// populated only by UI `startJob` cards. Any run dispatched outside the UI —
// an API call, a script, another tab's discarded card — produced NO trace
// anywhere once its in-memory event bus drained: a completed (or FAILED)
// worker was unobservable, which is how a finished checkup went missing from
// the history entirely (found 2026-09-15). This ledger is the server-side
// source of truth for "what runs happened", merged into /jobs by the page.
//
// Tolerant by design: one malformed line is skipped, never fatal — a ledger
// that throws is worse than a ledger that misses a line.

import fs from "node:fs";
import path from "node:path";

export function runsLedgerPath(root) {
  return path.join(root, ".career-ops-web", "runs", "index.jsonl");
}

/** Append one terminated-run record. Fire-and-forget semantics: callers wrap
 *  in try/catch — a ledger failure must never fail the run itself. */
export function appendRunRecord(root, rec) {
  const file = runsLedgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

/** Read the ledger, newest first. Tolerant: skips blanks/malformed lines.
 *  @param {string} root
 *  @param {number} [limit] - max records returned (default 200). */
export function readRunHistory(root, limit = 200) {
  const file = runsLedgerPath(root);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      continue; // malformed line — skip, don't throw
    }
  }
  return out.reverse().slice(0, limit);
}
