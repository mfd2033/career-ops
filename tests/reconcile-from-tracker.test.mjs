// tests/reconcile-from-tracker.test.mjs — reconcile-pipeline.mjs --from-tracker
//
// The structural guarantee: "this JD was evaluated" used to live in two
// implementations (batch-state.tsv for CLI batch, --entry pairs for web), so a
// scoring entry point that wrote neither stranded its rows in Pendientes — the
// 2026-09-14 incident (25 evaluated rows stuck in the inbox). The tracker is
// where EVERY path must land a report to count as evaluated at all, so a full
// tracker sweep is the catch-all that self-heals regardless of entry point.
//
// These tests pin the mode end-to-end through the real script, including the
// two deliberate skips: a dead report link and a report without a **URL:**
// header must never produce a moved row.

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT, NODE, rmSync as rm } from './helpers.mjs';

console.log('\n🧹 reconcile-pipeline: --from-tracker full sweep');

let tmpRoot = null;
const allFixtures = [];
function makeFixture({ pipeline, reports = {}, tracker }) {
  const dir = mkdtempSync(join(ROOT, 'output', 'reconcile-tracker-test-'));
  tmpRoot = tmpRoot ?? dir;
  allFixtures.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, 'data/pipeline.md'), pipeline);
  for (const [name, body] of Object.entries(reports)) writeFileSync(join(dir, 'reports', name), body);
  if (tracker) writeFileSync(join(dir, 'data/applications.md'), tracker);
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

const report = (score, url) =>
  `**Company:** x\n**URL:** ${url}\n**Score:** ${score}\n**PDF:** not generated\n`;

// Tracker rows mirror the real tracker's shape: Report cell links the report
// file; the URL cell may be EMPTY (rows #912/#901/#890 in the real tracker).
const trackerRow = (num, file, url) =>
  `| ${num} | 2026-09-14 | Acme | Engineer | 3.5/5 | Evaluated | ❌ | [${num}](../reports/${file}) | notes | ${url} |`;
const TRACKER = [
  '# Applications Tracker', '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |',
  '|---|------|---------|------|-------|--------|-----|--------|-------| --- |',
  trackerRow(801, '801-acme.md', 'https://jobs.example.com/1'),
  trackerRow(802, '802-beta.md', ''), // URL cell empty — the report's **URL:** header must carry it
  trackerRow(803, '803-dead.md', 'https://jobs.example.com/3'), // report file missing on disk
  trackerRow(804, '804-nourl.md', ''), // report exists but has no **URL:** header
  '',
].join('\n');

const BASE_PIPELINE = [
  '# Pipeline', '',
  '## Pending', '',
  '- [ ] https://jobs.example.com/1 | Acme | Senior Engineer',
  '- [ ] https://jobs.example.com/2?utm_source=feed | Beta | Backend Dev',
  '- [ ] https://jobs.example.com/3 | Gamma | Data Engineer',
  '- [ ] https://jobs.example.com/4 | Delta | PM', '',
  '## Processed', '',
].join('\n');

// ── 1. The headline: rows evaluated by ANY entry point self-heal ─────────────
{
  const fixture = makeFixture({
    pipeline: BASE_PIPELINE,
    tracker: TRACKER,
    reports: {
      '801-acme.md': report('4.5/5', 'https://jobs.example.com/1'),
      '802-beta.md': report('3.0/5', 'https://jobs.example.com/2'), // tracker URL cell empty
      // 803-dead.md deliberately missing; 804-nourl.md has no URL header
      '804-nourl.md': '**Company:** x\n**Score:** 2/5\n**PDF:** not generated\n',
    },
  });
  const res = runReconcile(fixture, ['--from-tracker']);
  if (!res.ok) fail(`--from-tracker should succeed — ${res.stderr.split('\n')[0]}`);
  else {
    const md = readFileSync(join(fixture, 'data/pipeline.md'), 'utf-8');
    const procIdx = md.indexOf('## Processed');
    const proc = procIdx >= 0 ? md.slice(procIdx) : '';
    const pend = md.slice(md.indexOf('## Pending'), procIdx >= 0 ? procIdx : undefined);

    proc.includes('https://jobs.example.com/1')
      ? pass('URL #1 moved (tracker URL cell → report link → report URL)')
      : fail('URL #1 not moved');
    proc.includes('https://jobs.example.com/2')
      ? pass('URL #2 moved even though its tracker URL cell is empty (report **URL:** header)')
      : fail('URL #2 not moved — report **URL:** header not consulted');
    pend.includes('https://jobs.example.com/3')
      ? pass('a dead report link never moves a row (no fabricated Processed entry)')
      : fail('URL #3 moved despite its report file being missing');
    pend.includes('https://jobs.example.com/4')
      ? pass('a report without a **URL:** header never moves a row')
      : fail('URL #4 moved despite no URL evidence');
    proc.includes('[801](../reports/801-acme.md)')
      ? pass('moved rows link their report file (path normalized to data/)')
      : fail('report link missing on moved row');
    proc.includes('4.5/5') ? pass('score resolved from the report') : fail('score not resolved');
  }

  // ── 2. Idempotency: a second sweep is a byte-identical no-op ───────────────
  const before = readFileSync(join(fixture, 'data/pipeline.md'), 'utf-8');
  const res2 = runReconcile(fixture, ['--from-tracker']);
  const after = readFileSync(join(fixture, 'data/pipeline.md'), 'utf-8');
  res2.ok && after === before
    ? pass('a second sweep is a byte-identical no-op')
    : fail('a second sweep changed the file or failed');
}

// ── 3. A tracker without any resolvable URL is a friendly no-op ──────────────
{
  const fixture = makeFixture({
    pipeline: BASE_PIPELINE,
    tracker: TRACKER,
    reports: { '804-nourl.md': '**Company:** x\n**Score:** 2/5\n' },
  });
  const res = runReconcile(fixture, ['--from-tracker']);
  if (!res.ok) fail(`sweep with no resolvable URLs should not crash — ${res.stderr.split('\n')[0]}`);
  else {
    const md = readFileSync(join(fixture, 'data/pipeline.md'), 'utf-8');
    (md.match(/^- \[ \]/gm) || []).length === 4
      ? pass('no evidence → no rows moved, pipeline untouched')
      : fail('rows moved without report-backed URL evidence');
  }
}

for (const dir of allFixtures) { try { rm(dir, { recursive: true, force: true }); } catch { /* Windows EPERM */ } }
