// verify-pipeline 的两条新增检查：
//   Check 15 — 两个报告文件共用同一个报告号（error）
//   Check 16 — pipeline.md 待处理条目的 URL 已经存在于 tracker（warning）
//
// 两条都靠 CAREER_OPS_TRACKER / CAREER_OPS_REPORTS / CAREER_OPS_PIPELINE
// 指向临时 fixture，避免触碰真实数据层。
//
// Run:  node --test tests/verify-pipeline-report-checks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'verify-pipeline.mjs');

const HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Via | Role | Score | Status | Planned | PDF | Report | Notes | URL |',
  '|---|------|---------|-----|------|-------|--------|---|-----|--------|-------|---|',
].join('\n');

/**
 * 建一个临时 fixture：tracker + reports/ + pipeline.md，跑一遍 verify-pipeline。
 *
 * @param {{rows: string[], reports: string[], pipeline?: string}} fixture
 * @returns {{status: number|null, out: string}}
 */
function runFixture({ rows, reports, pipeline = '' }) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-vp-'));
  try {
    const dataDir = join(dir, 'data');
    const reportsDir = join(dir, 'reports');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(reportsDir, { recursive: true });

    const tracker = join(dataDir, 'applications.md');
    writeFileSync(tracker, `${HEADER}\n${rows.join('\n')}\n`, 'utf-8');
    const pipelineFile = join(dataDir, 'pipeline.md');
    writeFileSync(pipelineFile, pipeline, 'utf-8');
    for (const name of reports) {
      writeFileSync(join(reportsDir, name), '# Evaluation: Acme — Project Manager\n', 'utf-8');
    }

    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CAREER_OPS_TRACKER: tracker,
        CAREER_OPS_REPORTS: reportsDir,
        CAREER_OPS_PIPELINE: pipelineFile,
      },
    });
    return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const row = (num, report, url) =>
  `| ${num} | 2026-10-29 | Acme | — | Project Manager | 3.0/5 | Evaluated | — | ❌ | ${report} | fixture | ${url} |`;

test('two report files sharing a number is an error (jd-capture resolves by that prefix)', () => {
  const { status, out } = runFixture({
    rows: [
      row(1, '[1](../reports/1-acme-a-2026-10-29.md)', 'https://example.com/jobs/1'),
      row(2, '[1](../reports/1-acme-b-2026-10-29.md)', 'https://example.com/jobs/2'),
    ],
    reports: ['1-acme-a-2026-10-29.md', '1-acme-b-2026-10-29.md'],
  });
  assert.equal(status, 1, out);
  assert.match(out, /Duplicate report number #1/);
});

test('distinct report numbers stay clean', () => {
  const { status, out } = runFixture({
    rows: [
      row(1, '[1](../reports/1-acme-a-2026-10-29.md)', 'https://example.com/jobs/1'),
      row(2, '[2](../reports/2-acme-b-2026-10-29.md)', 'https://example.com/jobs/2'),
    ],
    reports: ['1-acme-a-2026-10-29.md', '2-acme-b-2026-10-29.md'],
  });
  assert.equal(status, 0, out);
  assert.match(out, /No duplicate report numbers/);
});

test('a pending pipeline entry whose URL is already in the tracker warns (#1161/#1164)', () => {
  const { status, out } = runFixture({
    rows: [row(1, '[1](../reports/1-acme-a-2026-10-29.md)', 'https://example.com/jobs/1?utm_source=cpc')],
    reports: ['1-acme-a-2026-10-29.md'],
    // 同一职位、带跟踪参数的两种写法：#1117/#1129 与 #1161/#1164 的成因。
    pipeline: '- [ ] <https://example.com/jobs/1> | Acme | Project Manager | 郑州 | posted: 2026-10-29\n',
  });
  assert.equal(status, 0, out);
  assert.match(out, /Pending pipeline entry already evaluated as #1/);
});

test('a pending pipeline entry with no tracker row stays silent', () => {
  const { status, out } = runFixture({
    rows: [row(1, '[1](../reports/1-acme-a-2026-10-29.md)', 'https://example.com/jobs/1')],
    reports: ['1-acme-a-2026-10-29.md'],
    pipeline: '- [ ] <https://example.com/jobs/999> | Acme | Other Role | 郑州 | posted: 2026-10-29\n',
  });
  assert.equal(status, 0, out);
  assert.match(out, /No pending pipeline entry is already in the tracker/);
});

test('a ticked-off entry is never re-reported', () => {
  const { status, out } = runFixture({
    rows: [row(1, '[1](../reports/1-acme-a-2026-10-29.md)', 'https://example.com/jobs/1')],
    reports: ['1-acme-a-2026-10-29.md'],
    pipeline: '- [x] <https://example.com/jobs/1> | Acme | Project Manager | 郑州 | posted: 2026-10-29\n',
  });
  assert.equal(status, 0, out);
  assert.match(out, /No pending pipeline entry is already in the tracker/);
});
