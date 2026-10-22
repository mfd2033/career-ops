/**
 * tracker-links.mjs — Shared report-link normalization for the tracker.
 *
 * Markdown links resolve relative to the file that contains them, so a report
 * link in applications.md must be relative to wherever that tracker file lives:
 * `../reports/...` when the tracker is at `data/applications.md`, or
 * `reports/...` when it sits at the repo root.
 *
 * Report files canonically live in `<repoRoot>/reports/`, so we resolve the
 * incoming link to that absolute location regardless of how it was written
 * (root-relative `reports/...` per the TSV convention, or an already-normalized
 * `../reports/...`) and recompute the path with path.relative. Idempotent:
 * re-running never double-prefixes a link. See issue #760.
 *
 * WHY THE SCANNER IS NOT A REGEX: a `\]\(([^)]+)\)` regex stops at the FIRST
 * `)`, but a report filename legitimately contains parentheses — a Chinese
 * company slug such as `012-中原量子(郑州)科技有限公司-2026-10-12.md` is a normal
 * capture. The truncated target then points at a file that does not exist, so
 * verify-pipeline reported "Report not found" for a report sitting right there,
 * and merge/normalization paths could rewrite a link into a broken one. CommonMark
 * allows balanced parentheses in a link destination, so the scanner here mirrors
 * that rule (plus the `<...>` destination form) instead of guessing.
 */

import { join, relative, sep } from 'path';

/**
 * Scan markdown inline links `[label](destination)` and report the destination
 * span of each. Parentheses inside the destination are tracked as nesting, so a
 * filename carrying `(郑州)` stays intact; a `<...>`-wrapped destination is read
 * verbatim up to its `>`.
 *
 * @param {string} text
 * @returns {Array<{start:number, end:number, target:string}>} `start`/`end` are
 *   offsets of the destination inside `text` (`end` exclusive, before the closing
 *   paren); slice them to swap the target in place.
 */
export function findReportLinks(text) {
  const source = String(text ?? '');
  const links = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('](', cursor);
    if (open === -1) break;
    let i = open + 2;
    while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++;
    if (source[i] === '<') {
      const close = source.indexOf('>', i + 1);
      if (close === -1) break; // unterminated angle destination
      links.push({ start: i + 1, end: close, target: source.slice(i + 1, close) });
      cursor = close + 1;
      continue;
    }
    const start = i;
    let depth = 0;
    let end = -1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '\\') {
        i++; // an escaped char never closes or opens anything
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      }
    }
    if (end === -1) break; // unterminated destination — nothing to replace
    links.push({ start, end, target: source.slice(start, end) });
    cursor = end + 1;
  }
  return links;
}

/**
 * The destination of every inline link in `text`, in order. Consumers that only
 * need to READ links (validity checks, orphan detection, report-number folding)
 * should use this rather than re-spelling the regex — that spelling is what
 * truncated parenthesised filenames.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractReportLinkTargets(text) {
  return findReportLinks(text).map((link) => link.target);
}

/**
 * Rewrite every inline link destination in `text`, leaving labels and all other
 * bytes untouched.
 *
 * @param {string} text
 * @param {(target: string) => string|null|undefined} mapTarget Return the new
 *   destination, or null/undefined to keep the current one.
 * @returns {string}
 */
export function replaceReportLinkTargets(text, mapTarget) {
  const source = String(text ?? '');
  const links = findReportLinks(source);
  if (links.length === 0) return source;
  let out = '';
  let cursor = 0;
  for (const link of links) {
    const mapped = mapTarget(link.target);
    out += source.slice(cursor, link.start);
    out += typeof mapped === 'string' ? mapped : link.target;
    cursor = link.end;
  }
  return out + source.slice(cursor);
}

/**
 * Rewrite every report link in a string so its path is relative to trackerDir.
 *
 * @param {string} reportField  Text containing one or more `[label](path)` links.
 * @param {string} trackerDir   Absolute dir of the tracker file (dirname of applications.md).
 * @param {string} repoRoot     Absolute repo root where `reports/` lives.
 * @returns {string} The same text with report links normalized.
 */
export function normalizeReportLink(reportField, trackerDir, repoRoot) {
  return replaceReportLinkTargets(reportField, (linkPath) => {
    const m = linkPath.match(/^(?:\.\.\/)*(reports\/.+)$/);
    if (!m) return null; // not a report path — leave untouched
    const reportAbs = join(repoRoot, m[1]);
    return relative(trackerDir, reportAbs).split(sep).join('/');
  });
}
