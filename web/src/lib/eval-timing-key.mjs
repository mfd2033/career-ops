// Pure helpers for joining a tracker row to its 评估用时 entry
// (data/eval-timings.tsv, ADR-0016/0017). Plain .mjs so a node --test suite can
// lock the contract (tests/lib/eval-timing-key.test.mjs).
//
// Why the join key is not simply the row number: a re-evaluation reserves a NEW
// report number and merge-tracker updates the row IN PLACE — the row keeps its
// original #N while its Report link starts pointing at the new report file.
// The 评估用时 panel follows the row's CURRENT report link (the user's mental
// model is "row = the posting's latest facts"), falling back to the row number
// itself for legacy/unlinked rows. Numbers are zero-pad-insensitive: the timing
// TSV writer and the link label may disagree on padding ("035" vs "35").

/** The report number a tracker row's Report link currently points at, or null.
 *  Link spellings seen in the wild: `[001](reports/001-…)` and the
 *  tracker-relative `[001](../reports/001-…)`. */
export function currentReportNum(reportCell) {
  const m = String(reportCell ?? "").match(/\[(\d{1,4})\]\(/);
  return m ? String(parseInt(m[1], 10)) : null;
}

function normalizeReportNum(n) {
  const s = String(n ?? "").trim();
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s;
}

/** The eval-timings key for a tracker row: its current report number when the
 *  Report link resolves, else the row's own number. Missing row → "". */
export function evalTimingKey(app) {
  return currentReportNum(app?.report) ?? normalizeReportNum(app?.n);
}
