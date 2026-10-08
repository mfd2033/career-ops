// tests/report-pdf-backfill.test.mjs — generate-pdf.mjs report-header backfill (N3)
//
// The evaluation writes a report's `**PDF:**` line once, at scoring time; once a
// PDF was actually rendered, nothing rewrote that line, so the report said
// "未生成 / not generated" while the tracker and data/pdf-index.tsv said the PDF
// existed. renderInPage now backfills it after a CONFIRMED render. Two units:
//   - rewriteReportPdfLine: pure string transform (never fabricates a header)
//   - backfillReportPdfLine: resolves reports/{NNN}-*.md and rewrites its line,
//     best-effort (missing dir / no file / no PDF line → no-op, never throws).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT, rmSync as rm } from './helpers.mjs';
import { rewriteReportPdfLine, backfillReportPdfLine } from '../generate-pdf.mjs';

console.log('\n📝 generate-pdf: report **PDF:** header backfill');

// ── rewriteReportPdfLine (pure) ───────────────────────────────────
{
  const withLine = '**Company:** Acme\n**PDF:** pending\n**Score:** 4/5\n';
  const out = rewriteReportPdfLine(withLine, 'output/cv-acme-2026-10-08.pdf');
  out.includes('**PDF:** output/cv-acme-2026-10-08.pdf')
    ? pass('rewrites the existing PDF line to the generated path')
    : fail(`PDF line not rewritten: ${JSON.stringify(out)}`);
  out.includes('**Company:** Acme') && out.includes('**Score:** 4/5')
    ? pass('leaves every other header line untouched')
    : fail('other report lines were altered');

  const noLine = '**Company:** Acme\n**Score:** 4/5\n';
  rewriteReportPdfLine(noLine, 'output/x.pdf') === noLine
    ? pass('a report without a PDF line is returned unchanged (never fabricates one)')
    : fail('a PDF line was fabricated on a report that had none');

  // Value with surrounding free text collapses to the new value only.
  const cjk = '**PDF:** 未生成 — 运行 pdf 模式生成\n';
  const cjkOut = rewriteReportPdfLine(cjk, 'output/cv-cjk.pdf');
  cjkOut === '**PDF:** output/cv-cjk.pdf\n'
    ? pass('replaces Chinese free-text wording, not just the English form')
    : fail(`Chinese wording not fully replaced: ${JSON.stringify(cjkOut)}`);

  // An empty PDF value must rewrite ONLY that line, never swallow the next one.
  const emptyVal = rewriteReportPdfLine('**PDF:**\n**Score:** 4/5\n', 'output/cv-e.pdf');
  emptyVal === '**PDF:** output/cv-e.pdf\n**Score:** 4/5\n'
    ? pass('an empty PDF value rewrites only that line (does not eat the next)')
    : fail(`empty-value rewrite bled into the next line: ${JSON.stringify(emptyVal)}`);
}

// ── backfillReportPdfLine (filesystem, report number resolution) ──
const dir = mkdtempSync(join(ROOT, 'output', 'pdf-backfill-test-'));
try {
  const reportsDir = join(dir, 'reports');
  mkdirSync(reportsDir, { recursive: true });

  // Zero-padded filename, unpadded selector — must still resolve (042 → 42).
  writeFileSync(join(reportsDir, '042-foo-2026-10-08.md'), '**Company:** Foo\n**PDF:** pending\n');
  const did = backfillReportPdfLine('42', 'output/cv-foo-2026-10-08.pdf', { reportsDir });
  const md = readFileSync(join(reportsDir, '042-foo-2026-10-08.md'), 'utf-8');
  did && md.includes('**PDF:** output/cv-foo-2026-10-08.pdf')
    ? pass('backfills by report number, tolerant of zero-padded filenames')
    : fail(`backfill by number failed (did=${did}, md=${JSON.stringify(md)})`);

  // A report whose header has no PDF line → no-op, returns false.
  writeFileSync(join(reportsDir, '777-bar.md'), '**Company:** Bar\n**Score:** 3/5\n');
  const beforeBar = readFileSync(join(reportsDir, '777-bar.md'), 'utf-8');
  backfillReportPdfLine('777', 'output/cv-bar.pdf', { reportsDir }) === false
    && readFileSync(join(reportsDir, '777-bar.md'), 'utf-8') === beforeBar
    ? pass('a report without a PDF line is left untouched (returns false)')
    : fail('a PDF line was written onto a report that had none');

  // No file for the number → false, nothing thrown.
  backfillReportPdfLine('999', 'output/cv-none.pdf', { reportsDir }) === false
    ? pass('a report number with no matching file is a silent no-op')
    : fail('backfill matched a report that does not exist');

  // A nonexistent reports dir → false, nothing thrown (best-effort guard).
  backfillReportPdfLine('1', 'output/cv-x.pdf', { reportsDir: join(dir, 'does-not-exist') }) === false
    ? pass('a missing reports dir is a silent no-op (never throws)')
    : fail('backfill threw or matched through a missing reports dir');
} finally {
  try { rm(dir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
}
