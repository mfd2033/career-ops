/**
 * Blacklist table — single source of truth for parsing and rewriting the user's
 * `data/blacklist.md` (ADR-0084). Owned here so `scan.mjs` (the hard-gate
 * consumer) and the web `/api/blacklist` management route share ONE parser and
 * ONE serializer — a web-side mirror would drift (#954 lesson).
 *
 * The file is a small markdown table the user owns:
 *   | Company | Since | Scope | Exempt until | Reason |
 * Columns are located by HEADER NAME, never by position: `Exempt until` was
 * appended before `Reason`, so a positional reader would silently read the
 * exemption date as the reason once the 5th column lands. A headerless file
 * falls back to the historical positional layout so nothing that predates the
 * header convention breaks.
 *
 * Pure module (no fs, no clock): callers read/write the file and inject `today`.
 */
import { normalizeCompany, cell } from '../tracker-utils.mjs';

/** Canonical 5-column header row (ADR-0084). */
export const BLACKLIST_HEADER = '| Company | Since | Scope | Exempt until | Reason |';
const BLACKLIST_SEPARATOR = '|---------|-------|-------|--------------|--------|';

const normHeader = (h) => String(h ?? '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Safe wrapper around the shared normalizeCompany, exported so downstream
 * consumers (the web /api/blacklist store) key companies identically to the
 * parser without importing tracker-utils directly. Empty/whitespace → ''.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeCompanySafe(name) {
  try {
    return normalizeCompany(String(name ?? '').trim());
  } catch {
    return '';
  }
}

/**
 * Split raw blacklist.md into the prose preamble (everything before the table)
 * and an ordered array of data rows. The preamble is preserved verbatim on
 * re-render so the user's own notes above the table survive an edit.
 *
 * @param {string} text
 * @returns {{ preamble: string, rows: Array<{company:string, since:string, scope:string, exemptUntil:string, reason:string}> }}
 */
export function readBlacklistTable(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  let col = { company: 1, since: 2, scope: 3, reason: 4, exemptuntil: undefined };
  let sawHeader = false;
  let tableStart = -1;
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim());
    const headerKeys = new Set(cells.map(normHeader).filter(Boolean));
    // A header row is identified by the PRESENCE of the Company + Since column
    // names, not by their position — the table may be reordered (ADR-0084).
    if (!sawHeader && headerKeys.has('company') && headerKeys.has('since')) {
      const derived = {};
      cells.forEach((c, idx) => { const k = normHeader(c); if (k) derived[k] = idx; });
      col = {
        company: derived['company'] ?? 1,
        since: derived['since'] ?? 2,
        scope: derived['scope'] ?? 3,
        reason: derived['reason'] ?? 4,
        exemptuntil: derived['exemptuntil'],
      };
      sawHeader = true;
      tableStart = i;
      continue;
    }
    if (tableStart === -1) continue; // a `|` line before any header is prose, not a row
    const company = cells[col.company] || '';
    if (!company || /^[-: ]+$/.test(company)) continue; // separator row
    rows.push({
      company,
      since: cells[col.since] || '',
      scope: cells[col.scope] || '',
      exemptUntil: (col.exemptuntil != null ? cells[col.exemptuntil] : '') || '',
      reason: cells[col.reason] || '',
    });
  }

  const preamble = tableStart === -1 ? lines.join('\n').replace(/\s*$/, '') : lines.slice(0, tableStart).join('\n').replace(/\s*$/, '');
  return { preamble, rows };
}

/**
 * Parse the do-not-apply list into a Map keyed by normalized company (first row
 * wins on a duplicate key). This is the shape `scan.mjs` filters on. Built on
 * readBlacklistTable so parsing lives in exactly one place.
 *
 * @param {string} text
 * @returns {Map<string, {company:string, since:string, scope:string, exemptUntil:string, reason:string}>}
 */
export function parseBlacklist(text) {
  const entries = new Map();
  for (const row of readBlacklistTable(text).rows) {
    const key = normalizeCompany(row.company);
    if (!key || entries.has(key)) continue;
    entries.set(key, row);
  }
  return entries;
}

/**
 * Render rows back into a full blacklist.md: the preserved preamble, then the
 * canonical 5-column table. Cells are sanitized with the shared `cell()` so a
 * stray pipe or newline can never shift a column.
 *
 * @param {string} preamble
 * @param {Array<{company:string, since:string, scope:string, exemptUntil:string, reason:string}>} rows
 * @returns {string}
 */
export function renderBlacklistTable(preamble, rows) {
  const table = [
    BLACKLIST_HEADER,
    BLACKLIST_SEPARATOR,
    ...rows.map((r) => `| ${cell(r.company)} | ${cell(r.since)} | ${cell(r.scope)} | ${cell(r.exemptUntil)} | ${cell(r.reason)} |`),
  ].join('\n');
  const head = (preamble || '# Company Blacklist').replace(/\s*$/, '');
  return `${head}\n\n${table}\n`;
}

/**
 * Is a company currently exempt from the gate? True when `exemptUntil` is a
 * valid ISO date that is today or in the future (the gate lifts until that date
 * passes, then re-arms automatically). Blank / malformed / past → false.
 *
 * @param {string} exemptUntil - `YYYY-MM-DD` or ''.
 * @param {string} today - `YYYY-MM-DD` (injected; never read from the clock).
 */
export function isExemptActive(exemptUntil, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(exemptUntil || ''))) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return false;
  return String(exemptUntil) >= String(today); // ISO dates compare lexicographically
}

/** Add a company row (no-op if the normalized key already exists). Returns the new rows array. */
export function addRow(rows, { company, since, scope = 'company', exemptUntil = '', reason = '' }) {
  const key = normalizeCompany(company);
  if (!key || rows.some((r) => normalizeCompany(r.company) === key)) return rows;
  return [...rows, { company, since, scope, exemptUntil, reason }];
}

/** Remove a company row by normalized key. Returns the new rows array. */
export function removeRow(rows, company) {
  const key = normalizeCompany(company);
  return rows.filter((r) => normalizeCompany(r.company) !== key);
}

/** Set (or clear, with '') the Exempt until date for a company. Returns the new rows array. */
export function setExempt(rows, company, exemptUntil) {
  const key = normalizeCompany(company);
  return rows.map((r) => (normalizeCompany(r.company) === key ? { ...r, exemptUntil } : r));
}
