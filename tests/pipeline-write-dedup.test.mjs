// tests/pipeline-write-dedup.test.mjs — appendToPipeline's WRITE-POINT dedup.
//
// The upstream gates (scan-history dedup, each caller's seen-set) are advisory:
// the 2026-09-14 incident showed one skipped gate grows 9,161 pending rows for
// 2,500 postings. The invariant "the same posting never enters pipeline.md
// twice" now lives AT the write point: the file itself refuses duplicate keys
// (url-key.mjs normalizeUrl — the same canonical key merge-tracker and the web
// inbox use), both against rows already on disk (Pending AND Processed) and
// within the incoming batch.
//
// Also pins the injectable path ({ pipelinePath }): PIPELINE_PATH is a module
// constant, so tests must never write the real data/pipeline.md.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT, rmSync as rm } from './helpers.mjs';

console.log('\n📝 appendToPipeline: write-point dedup on canonical URL keys');

const { appendToPipeline } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

let fixtureDir = null;
function makeFixture(pipelineText) {
  fixtureDir = mkdtempSync(join(ROOT, 'output', 'pipeline-dedup-test-'));
  mkdirSync(join(fixtureDir, 'data'), { recursive: true });
  const p = join(fixtureDir, 'data', 'pipeline.md');
  writeFileSync(p, pipelineText, 'utf-8');
  return p;
}
async function cleanup() {
  if (!fixtureDir) return;
  try { rm(fixtureDir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
  fixtureDir = null;
}

const offer = (url, company = 'Acme', title = 'Engineer') => ({ url, company, title });

// ── 1. The batch itself collapses duplicates ─────────────────────────────────
{
  const p = makeFixture('# Pipeline\n\n## Pending\n');
  await appendToPipeline([
    offer('https://jobs.example.com/1'),
    offer('https://jobs.example.com/1?utm_source=feed'), // same posting, new spelling
    offer('https://jobs.example.com/2'),
  ], { pipelinePath: p });
  const md = readFileSync(p, 'utf-8');
  const n = (md.match(/^- \[ \]/gm) || []).length;
  n === 2 ? pass('two spellings of one posting in one batch collapse to one row')
          : fail(`expected 2 pending rows, got ${n}:\n${md}`);
  await cleanup();
}

// ── 2. A URL already in Pending is refused at the write point ────────────────
{
  const p = makeFixture('# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Acme | Engineer\n');
  await appendToPipeline([offer('https://jobs.example.com/1?ka=x&securityId=y')], { pipelinePath: p });
  const md = readFileSync(p, 'utf-8');
  const n = (md.match(/^- \[ \]/gm) || []).length;
  n === 1 ? pass('re-offer with anti-bot params refused — row not duplicated')
          : fail(`expected 1 pending row, got ${n}:\n${md}`);
  await cleanup();
}

// ── 3. A URL already in Processed is refused too ─────────────────────────────
// Re-offering an evaluated posting is wrong in BOTH sections; the Processed
// row's URL sits in cell 2, after the report link.
{
  const p = makeFixture(
    '# Pipeline\n\n## Pending\n\n## Processed\n\n' +
    '- [x] [801](reports/801-acme.md) | <https://jobs.example.com/1> | Acme | Engineer | 4.5/5 | PDF ❌\n'
  );
  await appendToPipeline([offer('https://jobs.example.com/1')], { pipelinePath: p });
  const md = readFileSync(p, 'utf-8');
  (md.match(/^- \[ \]/gm) || []).length === 0
    ? pass('a posting already in Processed is not re-added to Pending')
    : fail(`processed posting re-added:\n${md}`);
  await cleanup();
}

// ── 4. Everything filtered → byte-identical no-op ────────────────────────────
{
  const before = '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Acme | Engineer\n';
  const p = makeFixture(before);
  await appendToPipeline([offer('http://jobs.example.com/1?utm_source=x')], { pipelinePath: p });
  const after = readFileSync(p, 'utf-8');
  after === before ? pass('an all-duplicates batch leaves the file byte-identical')
                   : fail('file changed despite nothing new to write');
  await cleanup();
}

// ── 5. New offers still land, and non-keyable URLs pass through ──────────────
{
  const p = makeFixture('# Pipeline\n\n## Pending\n');
  await appendToPipeline([
    offer('https://jobs.example.com/new'),
    offer('local:jds/916.md'), // no http(s) key → cannot dedupe → kept
  ], { pipelinePath: p });
  const md = readFileSync(p, 'utf-8');
  md.includes('https://jobs.example.com/new') ? pass('a genuinely new offer is appended')
                                              : fail('new offer was dropped:\n' + md);
  md.includes('local:jds/916.md') ? pass('a non-keyable URL passes through unfiltered')
                                  : fail('non-keyable URL was wrongly dropped');
  await cleanup();
}

// ── 6. The real data/pipeline.md is never touched by tests ───────────────────
{
  const p = makeFixture('# Pipeline\n\n## Pending\n');
  await appendToPipeline([offer('https://jobs.example.com/inject')], { pipelinePath: p });
  const real = readFileSync(join(ROOT, 'data', 'pipeline.md'), 'utf-8');
  !real.includes('jobs.example.com/inject')
    ? pass('injected pipelinePath is honored — the real inbox is untouched')
    : fail('test wrote into the REAL data/pipeline.md');
  await cleanup();
}
