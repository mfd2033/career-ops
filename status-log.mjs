// status-log.mjs — parse data/status-log.tsv into "first submission date per
// tracker #" for the weekly application pace (CO-52). Zero-dependency on
// purpose: both the canonical stats.mjs (repo root) and the web mirror
// web/src/lib/weekly-pace.mjs import THIS parser, so the two pace cards can
// never drift on how a status-log row is read.
//
// Why it exists: pace bucketing used to key on the tracker row's initial Date
// (the evaluation/entry day), so a row evaluated 2026-10-17 but actually sent
// 2026-10-21 counted in the evaluation week — the Analytics card showed
// "本周已投 0" on the day the user applied. status-log.tsv records every real
// status transition with its event date (--on aware, set-status.mjs writes
// it), which is the authoritative send date. Rows that never transitioned into
// a submitted state (bulk-seeded before the ledger existed) get no entry here;
// callers fall back to the row's own Date.

const LEADING_BOM = /^\uFEFF/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build tracker# → earliest submission-event date from status-log.tsv content.
 *
 * A submission event is any transition whose TO status proves a real send
 * (Applied/Responded/Interview/Offer/Hired/Rejected — the same set the funnel
 * calls everApplied; callers pass their own token list). Earliest wins so a
 * re-applied row (Discarded → Applied) keeps its first send date.
 *
 * @param {string} text - Raw status-log.tsv content (BOM/CRLF tolerated;
 *   missing file / empty string → empty Map).
 * @param {Iterable<string>} submittedTokens - Status tokens that prove a
 *   submission; matched case-insensitively against the TO cell.
 * @returns {Map<number, string>} tracker# → YYYY-MM-DD of the earliest event.
 */
export function submittedDatesFromStatusLog(text, submittedTokens) {
  const tokens = new Set([...(submittedTokens ?? [])].map((t) => String(t).toUpperCase()));
  const dates = new Map();
  if (typeof text !== "string" || !text.trim()) return dates;
  for (const line of text.replace(LEADING_BOM, "").replace(/\r/g, "").split("\n")) {
    const cells = line.split("\t");
    if (cells.length < 4) continue;
    const num = parseInt(cells[0], 10);
    const date = String(cells[1] ?? "").trim();
    const to = String(cells[3] ?? "").trim().toUpperCase();
    // Columns: # · date · from-status · to-status · source · note. parseInt
    // rejects the header line, malformed rows and anything with a BOM left.
    if (!Number.isFinite(num) || !DATE_RE.test(date) || !tokens.has(to)) continue;
    const prev = dates.get(num);
    if (prev === undefined || date < prev) dates.set(num, date);
  }
  return dates;
}
/**
 * Every recorded transition for ONE tracker row, newest first.
 *
 * The ledger is append-only and one line per real status change (set-status.mjs
 * writes it), so this is the audit trail behind a row's current state — what the
 * status history popup on the report page shows. Rows that predate the ledger
 * (bulk-seeded) simply have no events.
 *
 * Same column layout as submittedDatesFromStatusLog: `# · date · from · to ·
 * source · note`; source/note may be absent on older rows. Same-day events keep
 * the file's own order but are reversed so the most recent append reads first.
 *
 * @param {string} text - Raw status-log.tsv content (BOM/CRLF tolerated;
 *   missing file / empty string → empty array).
 * @param {number|string} n - Tracker row number.
 * @returns {Array<{date:string, from:string, to:string, source:string, note:string}>}
 */
export function statusEventsFromStatusLog(text, n) {
  const target = Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(target) || typeof text !== "string" || !text.trim()) return [];
  const events = [];
  let seq = 0;
  for (const line of text.replace(LEADING_BOM, "").replace(/\r/g, "").split("\n")) {
    const cells = line.split("\t");
    if (cells.length < 4) continue;
    // parseInt rejects the header line ("num"), malformed rows and short lines.
    if (Number.parseInt(cells[0], 10) !== target) continue;
    const date = String(cells[1] ?? "").trim();
    if (!DATE_RE.test(date)) continue;
    events.push({
      date,
      from: String(cells[2] ?? "").trim(),
      to: String(cells[3] ?? "").trim(),
      source: String(cells[4] ?? "").trim(),
      note: String(cells[5] ?? "").trim(),
      seq: seq++,
    });
  }
  events.sort((a, b) => (a.date === b.date ? b.seq - a.seq : a.date < b.date ? 1 : -1));
  return events.map(({ date, from, to, source, note }) => ({ date, from, to, source, note }));
}
