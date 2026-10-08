// tests/reconcile-pdf-resolution.test.mjs — reconcile-pipeline.mjs resolvePdf()
//
// Regression (ADR-0073 follow-up, N1): the old resolvePdf() read the report
// header's FREE TEXT and defaulted to "has PDF" (✅), only treating the English
// string "not generated" as absent. This fork writes reports in Chinese, and the
// wording follows config `language.output`, so `pending` / `❌` / 「未生成」 / a
// missing PDF line were ALL read as "PDF exists" — hundreds of reports mis-flagged
// in data/pipeline.md's PDF column.
//
// The fix decides PDF existence by EVIDENCE, default ❌:
//   1. a row in data/pdf-index.tsv for that report number → ✅ (authoritative)
//   2. the report header names a concrete output/*.pdf path or a ✅ → ✅
//   3. everything else → ❌
//
// These cases pin that matrix end-to-end through the real script, driving a
// FIXTURE pdf-index (so the verdict never depends on the developer's real
// manifest) via --tracker, and every wording the old rule got wrong.

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT, NODE, rmSync as rm } from './helpers.mjs';

console.log('\n🧾 reconcile-pipeline: resolvePdf evidence-first (default ❌)');

const allFixtures = [];
function makeFixture({ pipeline, reports, pdfIndex }) {
  const dir = mkdtempSync(join(ROOT, 'output', 'reconcile-pdf-test-'));
  allFixtures.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, 'data/pipeline.md'), pipeline);
  // A tracker file need not exist for --entry mode; passing --tracker only
  // anchors resolvePdfIndexPath() at the fixture's own data/pdf-index.tsv.
  if (pdfIndex !== undefined) writeFileSync(join(dir, 'data/pdf-index.tsv'), pdfIndex);
  for (const [name, body] of Object.entries(reports)) writeFileSync(join(dir, 'reports', name), body);
  return dir;
}

function runReconcile(fixture, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync(NODE, [join(ROOT, 'reconcile-pipeline.mjs'),
        '--pipeline', join(fixture, 'data/pipeline.md'),
        '--reports', join(fixture, 'reports'),
        '--tracker', join(fixture, 'data/applications.md'),
        ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 30000 }),
    };
  } catch (e) {
    return { ok: false, stdout: e?.stdout ?? '', stderr: e?.stderr ?? String(e) };
  }
}

// One report per PDF-header wording. `pdf` is the literal `**PDF:**` value;
// when null the report carries no PDF line at all.
const NUMS = {
  pending: 900,        // **PDF:** pending            → ❌
  cross: 901,          // **PDF:** ❌                  → ❌
  zh: 902,             // **PDF:** 未生成 — ...（中文） → ❌
  none: 903,           // (no PDF line)               → ❌
  notGen: 904,         // **PDF:** not generated      → ❌
  path: 905,           // **PDF:** output/…pdf        → ✅ (evidence 2)
  inIndex: 906,        // **PDF:** pending BUT in pdf-index → ✅ (evidence 1)
  checkMark: 907,      // **PDF:** ✅                  → ✅ (evidence 2)
};

function reportBody(url, pdf) {
  const head = `**Company:** x\n**URL:** ${url}\n**Score:** 3/5\n`;
  return pdf === null ? head : `${head}**PDF:** ${pdf}\n`;
}

const reports = {
  [`${NUMS.pending}-a.md`]: reportBody('https://jobs.example.com/900', 'pending'),
  [`${NUMS.cross}-a.md`]: reportBody('https://jobs.example.com/901', '❌'),
  [`${NUMS.zh}-a.md`]: reportBody('https://jobs.example.com/902', '未生成 — 运行 pdf 模式生成'),
  [`${NUMS.none}-a.md`]: reportBody('https://jobs.example.com/903', null),
  [`${NUMS.notGen}-a.md`]: reportBody('https://jobs.example.com/904', 'not generated'),
  [`${NUMS.path}-a.md`]: reportBody('https://jobs.example.com/905', 'output/cv-foo-2026-10-01.pdf'),
  [`${NUMS.inIndex}-a.md`]: reportBody('https://jobs.example.com/906', 'pending'),
  [`${NUMS.checkMark}-a.md`]: reportBody('https://jobs.example.com/907', '✅'),
};

// Fixture manifest carries a leading BOM + a `#` header line, then one data row
// for report 906 — exercising both the BOM and the header-skip in the reader.
const pdfIndex = '\uFEFF# report\tpdf\thtml\tformat\tdate\n'
  + `${NUMS.inIndex}\toutput/cv-indexed-2026-10-01.pdf\toutput/cv-indexed.html\ta4\t2026-10-01\n`;

const pipeline = [
  '# Pipeline', '', '## Pendientes', '',
  ...Object.values(NUMS).map(n => `- [ ] https://jobs.example.com/${n} | Acme | Role ${n}`),
  '',
].join('\n');

const entries = [];
for (const n of Object.values(NUMS)) entries.push('--entry', `${n}|https://jobs.example.com/${n}`);

const fixture = makeFixture({ pipeline, reports, pdfIndex });
const res = runReconcile(fixture, entries);
if (!res.ok) {
  fail(`reconcile --entry should succeed — ${res.stderr.split('\n')[0]}`);
} else {
  const md = readFileSync(join(fixture, 'data/pipeline.md'), 'utf-8');
  const procIdx = md.indexOf('## Procesadas');
  const proc = procIdx >= 0 ? md.slice(procIdx) : '';

  // Pull the PDF flag off the Procesadas line that links this report number.
  function pdfFlagFor(num) {
    const line = proc.split('\n').find(l => l.includes(`${num}-a.md`));
    if (!line) return '(missing)';
    if (line.includes('PDF ✅')) return '✅';
    if (line.includes('PDF ❌')) return '❌';
    return '(no flag)';
  }

  const expected = [
    [NUMS.pending, '❌', 'pending wording → ❌ (was wrongly ✅)'],
    [NUMS.cross, '❌', '❌ wording → ❌ (was wrongly ✅)'],
    [NUMS.zh, '❌', '中文「未生成」 → ❌ (was wrongly ✅)'],
    [NUMS.none, '❌', 'no PDF line → ❌'],
    [NUMS.notGen, '❌', 'English "not generated" → ❌ (unchanged)'],
    [NUMS.path, '✅', 'report names output/…pdf → ✅ (evidence 2)'],
    [NUMS.inIndex, '✅', 'pdf-index hit overrides "pending" wording → ✅ (evidence 1)'],
    [NUMS.checkMark, '✅', 'report header ✅ → ✅ (evidence 2)'],
  ];
  for (const [num, want, label] of expected) {
    const got = pdfFlagFor(num);
    if (got === want) pass(label);
    else fail(`${label} — expected PDF ${want}, got ${got}`);
  }
}

for (const dir of allFixtures) { try { rm(dir, { recursive: true, force: true }); } catch { /* Windows EPERM */ } }
