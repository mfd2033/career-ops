// status-log.mjs (web copy) — parse data/status-log.tsv into "first submission
// date per tracker #" for the weekly pace (CO-52), plus the full per-row
// transition history behind the report page's status-history popup.
//
// 为什么是副本：根目录同名模块是唯一事实源，但 next.config.mjs 把
// turbopack.root 钉在 web/（Windows 下 Turbopack postcss worker 无限 respawn
// 的缓解，vercel/next.js#92978），Turbopack 拒绝解析仓库根的文件 —— web 侧
// 无法跨根 import，只能自持一份。两份实现由守卫测试锁定：submittedDatesFromStatusLog
// 由 web/tests/lib/weekly-pace.test.mjs、statusEventsFromStatusLog 由
// web/tests/lib/status-log-events.test.mjs 逐事件比对根版；改任何一边都要同步
// 另一边并让守卫测试作证。
//
// 语义：submission 事件 = 任意转入「证明真实投递」状态的转换（调用方传 token
// 集）；同一行多次进入投递态取最早日期（重投行保留首次投递日）。BOM/CRLF 容忍。

const LEADING_BOM = /^\uFEFF/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build tracker# → earliest submission-event date from status-log.tsv content.
 *
 * @param {string} text - Raw status-log.tsv content (missing file / empty → empty Map).
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
 * Every recorded transition for ONE tracker row, newest first — the audit trail
 * behind a row's current state (the report page's status-history popup). Mirror
 * of the root status-log.mjs; see that file for the full rationale.
 *
 * @param {string} text - Raw status-log.tsv content (missing file / empty → empty array).
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
