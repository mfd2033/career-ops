// pipeline-sections.mjs — the ONE definition of "which lines of pipeline.md
// are the Pending chapter".
//
// pipeline.md is a sectioned document, not a flat checklist: scan.mjs owns the
// skeleton (`## Pending` / `## Processed`, with legacy Spanish markers) and the
// user may add their own scratch chapters (`## 非郑州`, `## 暂存`, …). A reader
// that checkbox-scans the WHOLE file drags those chapters into whatever it was
// reading — the 2026-09-14 incident: the web inbox showed 49 rows from user
// chapters, 25 of which had already been scored and folded into the tracker.
//
// scan.mjs is the section-format authority (PENDING_MARKERS / PROCESSED_MARKERS
// and appendToPipeline's insert logic); this module mirrors that semantics for
// read-side consumers. Kept in a pure .mjs so node --test can lock it (same
// tradeoff as inbox-score.mjs — the TS core imports it, tests import it
// directly).
//
// Legacy fallback: files written before the sectioned skeleton have no Pending
// header at all. Treat the whole file as pending there — those are exactly the
// files whose every checkbox row IS a pending offer — instead of returning
// nothing and silently emptying the inbox on old layouts.

/** Matches the Pending section header (English + legacy Spanish, like scan.mjs). */
export const PENDING_SECTION_RE = /^##\s+(pending|pendientes)\s*$/i;

const ANY_SECTION_RE = /^##\s+/;

/**
 * The lines that make up pipeline.md's Pending chapter.
 *
 * @param {string} md - Full text of data/pipeline.md.
 * @returns {string[]} Lines of the Pending section (header excluded), or ALL
 *   lines when the file carries no Pending header (legacy flat layout).
 */
export function pendingSectionLines(md) {
  const lines = String(md ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => PENDING_SECTION_RE.test(l));
  if (start < 0) return lines;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_SECTION_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}
