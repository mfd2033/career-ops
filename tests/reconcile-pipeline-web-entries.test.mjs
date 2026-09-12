// tests/reconcile-pipeline-web-entries.test.mjs
//
// Regression: the web batch-evaluate route (/api/batch-evaluate) folds its
// tracker rows via merge-tracker.mjs but NEVER touches data/pipeline.md, so
// every JD evaluated from the web inbox re-appeared in Pendientes after a
// refresh — the user's "some JDs came back to the inbox" report. The fix gives
// reconcile-pipeline.mjs a direct-entries mode (--entry num|url, repeatable)
// so a caller that has no batch-state.tsv (the web route) can still move its
// successfully-evaluated rows out of Pendientes, matched by the SAME
// normalizeUrl identity the rest of the pipeline uses.
//
// These tests pin that mode end-to-end through the real script, plus the
// pre-existing batch-state.tsv path so the lock/matching refactor cannot
// quietly break the CLI batch flow.

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT, NODE, rmSync as rm } from './helpers.mjs';

console.log('\n📥 reconcile-pipeline: direct --entry mode (web batch-evaluate path)');

let tmpRoot = null;
const allFixtures = [];
function makeFixture({ pipeline, reports = {}, state }) {
  const dir = mkdtempSync(join(ROOT, 'output', 'reconcile-web-test-'));
  tmpRoot = tmpRoot ?? dir;
  allFixtures.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, 'data/pipeline.md'), pipeline);
  for (const [name, body] of Object.entries(reports)) writeFileSync(join(dir, 'reports', name), body);
  if (state) writeFileSync(join(dir, 'batch-state.tsv'), state);
  return dir;
}

function runReconcile(fixture, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync(NODE, [join(ROOT, 'reconcile-pipeline.mjs'),
        '--pipeline', join(fixture, 'data/pipeline.md'),
        '--reports', join(fixture, 'reports'),
        ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 30000 }),
    };
  } catch (e) {
    return { ok: false, stdout: e?.stdout ?? '', stderr: e?.stderr ?? String(e) };
  }
}

const PENDING = '## Pendientes';
const PROCESSED = '## Procesadas';
const sectionsOf = (md) => {
  const pendIdx = md.indexOf(PENDING);
  const procIdx = md.indexOf(PROCESSED);
  return {
    pend: procIdx >= 0 ? md.slice(pendIdx, procIdx) : md.slice(pendIdx),
    proc: procIdx >= 0 ? md.slice(procIdx) : '',
  };
};

const report = (score) => `**Company:** x\n**Score:** ${score}\n**PDF:** not generated\n`;
const BASE_PIPELINE = [
  '# Pipeline', '',
  PENDING, '',
  '- [ ] https://jobs.example.com/1 | Acme | Senior Engineer',
  '- [ ] https://jobs.example.com/2 | Beta | Backend Dev',
  '- [ ] https://jobs.example.com/3 | Gamma | Data Engineer', '',
].join('\n');

// ── 1. The headline requirement: web-evaluated URLs leave Pendientes ─────────
{
  const fixture = makeFixture({
    pipeline: BASE_PIPELINE,
    reports: { '801-acme.md': report('4.5/5'), '802-beta.md': report('3/5') },
  });
  // URL #2 is sent with a tracking param and http→https difference, the way the
  // web route receives it from the shortlist (normalizeUrl keys) — the line in
  // pipeline.md is the clean URL, so matching must go through normalizeUrl.
  const res = runReconcile(fixture, [
    '--entry', '801|https://jobs.example.com/1',
    '--entry', '802|http://jobs.example.com/2?utm_source=mail',
  ]);
  if (!res.ok) fail(`--entry mode should succeed — ${res.stderr.split('\n')[0]}`);
  else {
    const md = readFileSync(join(fixture, 'data/pipeline.md'), 'utf-8');
    const { pend, proc } = sectionsOf(md);
    if (!proc) fail('a Procesadas section is created when the file has none');
    else {
      pass('a Procesadas section is created when the file has none');
      const p1 = proc.includes('https://jobs.example.com/1');
      const p2 = proc.includes('https://jobs.example.com/2');
      p1 ? pass('URL #1 (exact match) moved to Procesadas') : fail('URL #1 (exact match) not moved to Procesadas');
      p2 ? pass('URL #2 (normalizeUrl match, http+utm variant) moved to Procesadas') : fail('URL #2 not matched through normalizeUrl');
      pend.includes('/3') ? pass('unprocessed URL #3 stays in Pendientes') : fail('unprocessed URL #3 was wrongly moved');
      proc.includes('- [x]') ? pass('moved rows carry the [x] checkbox') : fail('moved rows are not [x]-checked');
      // Link paths are normalized relative to the pipeline file's dir (#760):
      // the fixture's pipeline.md sits in data/, so the link is ../reports/…
      proc.includes('[801](../reports/801-acme.md)') ? pass('moved rows link their report file') : fail('report link missing on moved row');
      proc.includes('4.5/5') ? pass('score is resolved from the report when the entry has none') : fail('score not resolved from the report');
      proc.includes('PDF ❌') ? pass('PDF flag resolved from the report') : fail('PDF flag missing');
    }
  }

  // ── 2. Idempotency: re-running the same batch must not duplicate ───────────
  const before = readFileSync(join(fixture, 'data/pipeline.md'), 'utf-8');
  const res2 = runReconcile(fixture, [
    '--entry', '801|https://jobs.example.com/1',
    '--entry', '802|http://jobs.example.com/2?utm_source=mail',
  ]);
  const after = readFileSync(join(fixture, 'data/pipeline.md'), 'utf-8');
  res2.ok && after === before
    ? pass('a second identical run is a byte-identical no-op')
    : fail('a second identical run changed the file or failed');
}

// ── 3. Missing report file guards against a dead link ────────────────────────
{
  const fixture = makeFixture({
    pipeline: BASE_PIPELINE,
    reports: { '801-acme.md': report('4.5/5') }, // no 802 report on disk
  });
  runReconcile(fixture, [
    '--entry', '801|https://jobs.example.com/1',
    '--entry', '802|https://jobs.example.com/2',
  ]);
  const md = readFileSync(join(fixture, 'data/pipeline.md'), 'utf-8');
  const { pend } = sectionsOf(md);
  pend.includes('/2') ? pass('an entry whose report is missing stays in Pendientes (no dead link)')
    : fail('an entry without a report was moved anyway');
}

// ── 4. The legacy batch-state.tsv path still works after the refactor ────────
{
  const state = ['id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries',
    '1\thttps://jobs.example.com/1\tcompleted\t2026-09-12\t2026-09-12\t801\t4.5\t\t0',
    '2\thttps://jobs.example.com/9\tcompleted\t2026-09-12\t2026-09-12\t899\t4.0\t\t0', '',
  ].join('\n');
  const fixture = makeFixture({
    pipeline: BASE_PIPELINE,
    reports: { '801-acme.md': report('4.5/5') },
    state,
  });
  const res = runReconcile(fixture, ['--state', join(fixture, 'batch-state.tsv')]);
  if (!res.ok) fail(`legacy batch-state mode should succeed — ${res.stderr.split('\n')[0]}`);
  else {
    const md = readFileSync(join(fixture, 'data/pipeline.md'), 'utf-8');
    const { pend, proc } = sectionsOf(md);
    proc.includes('/1') ? pass('legacy: state-completed URL moved to Procesadas') : fail('legacy: state-completed URL not moved');
    pend.includes('/2') ? pass('legacy: URL absent from state stays in Pendientes') : fail('legacy: untracked URL wrongly moved');
  }
}

// ── 5. Lock artifacts never leak after a run ─────────────────────────────────
{
  const fixture = makeFixture({
    pipeline: BASE_PIPELINE,
    reports: { '801-acme.md': report('4.5/5') },
  });
  runReconcile(fixture, ['--entry', '801|https://jobs.example.com/1']);
  existsSync(join(fixture, 'data/pipeline.md.lock'))
    ? fail('pipeline lock directory left behind after the run')
    : pass('pipeline lock directory is released after the run');
}

for (const dir of allFixtures) { try { rm(dir, { recursive: true, force: true }); } catch { /* Windows EPERM */ } }
