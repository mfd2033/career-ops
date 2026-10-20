/**
 * tracker-add.mjs — the single-row insert every /api/tracker write path goes
 * through.
 *
 * What is worth asserting here is not "it appends a line" but the four
 * properties that made this CLI necessary instead of a route writing the
 * markdown itself:
 *   - it de-duplicates, so a retried create cannot produce a second row for the
 *     same posting (the tracker is an application history, and a split row
 *     loses half the history);
 *   - it validates the state against templates/states.yml before touching
 *     anything;
 *   - it writes to the header's REAL width, so a customized table keeps its
 *     shape instead of gaining unparseable short rows;
 *   - it contends on the shared tracker lock, so a concurrent writer gets exit 4
 *     (mapped to a retryable 503) rather than a lost update.
 *
 * Every case runs against a fixture tracker through CAREER_OPS_TRACKER; the
 * real data/applications.md is hashed before and after the whole file to prove
 * the suite never reached it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { rmSync } from './helpers.mjs';
import { acquireTrackerLock } from '../tracker-utils.mjs';
import { localToday } from '../lib/local-today.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REAL_TRACKER = join(ROOT, 'data', 'applications.md');

/** Hash of the user's real tracker, or null when this checkout has none. */
function realTrackerHash() {
  try {
    return createHash('sha256').update(readFileSync(REAL_TRACKER)).digest('hex');
  } catch {
    return null;
  }
}

const REAL_HASH_BEFORE = realTrackerHash();

const HEADER_9 = [
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
];

const HEADER_10 = [
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|-----|',
];

/**
 * A throwaway workspace holding one tracker file.
 *
 * @param {string[]} header - Header + separator rows.
 * @param {string[]} [rows] - Data rows.
 * @returns {{dir: string, tracker: string, env: Record<string,string>, read: () => string, cleanup: () => void}}
 */
function fixture(header, rows = []) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-tracker-add-'));
  const tracker = join(dir, 'applications.md');
  writeFileSync(tracker, ['# Applications Tracker', '', ...header, ...rows, ''].join('\n'));
  return {
    dir,
    tracker,
    env: {
      CAREER_OPS_TRACKER: tracker,
      CAREER_OPS_TRACKER_DB: join(dir, 'applications.db'),
      CAREER_OPS_TRACKER_LOCK: join(dir, 'career-ops-merge-tracker-add.lock'),
      CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '3000',
      CAREER_OPS_TRACKER_LOCK_RETRY_MS: '20',
    },
    read: () => readFileSync(tracker, 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Run tracker-add.mjs against a fixture.
 *
 * @param {Record<string,string>} env - Fixture environment.
 * @param {string[]} args
 * @param {Record<string,string>} [extraEnv]
 * @returns {{code: number|null, stdout: string, stderr: string, doc: any}}
 */
function add(env, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [join(ROOT, 'tracker-add.mjs'), ...args, '--json'], {
    cwd: ROOT,
    env: { ...process.env, ...env, ...extraEnv },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const stdout = result.stdout ?? '';
  return { code: result.status, stdout, stderr: result.stderr ?? '', doc: lastJson(stdout) };
}

/**
 * The last JSON document on stdout (the CLIs print it after any diagnostics).
 *
 * @param {string} stdout
 * @returns {any} Parsed document, or null.
 */
function lastJson(stdout) {
  const lines = String(stdout ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim().startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      // not the document start — keep scanning
    }
  }
  return null;
}

/** Data rows only (the header and separator are not applications). */
function dataRows(content) {
  return content.split('\n').filter((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    return /^\d+$/.test(cells[1] ?? '');
  });
}

test('creates one row: next number, Applied by default, inserted below the separator', () => {
  const fx = fixture(HEADER_9, [
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | [1](reports/001-acme.md) | seed |',
  ]);
  try {
    const run = add(fx.env, ['--company', 'Beta', '--role', 'Data Analyst']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.verdict, 'created');
    assert.equal(run.doc.num, 2);
    assert.equal(run.doc.status, 'Applied');
    assert.equal(run.doc.date, localToday());

    const rows = dataRows(fx.read());
    assert.equal(rows.length, 2);
    // Newest first: merge-tracker inserts at the same point for the same reason.
    assert.match(rows[0], /^\| 2 \|/);
    const cells = rows[0].split('|').map((cell) => cell.trim());
    assert.deepEqual(cells.slice(2, -1), [
      localToday(), 'Beta', 'Data Analyst', '—', 'Applied', '❌', '—', '',
    ]);
  } finally {
    fx.cleanup();
  }
});

test('resolves a status alias through states.yml instead of storing it verbatim', () => {
  const fx = fixture(HEADER_9);
  try {
    const run = add(fx.env, ['--company', 'Acme', '--role', 'Engineer', '--status', 'aplicado']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.status, 'Applied');
    assert.match(fx.read(), /\| Applied \|/);
    assert.doesNotMatch(fx.read(), /aplicado/);
  } finally {
    fx.cleanup();
  }
});

test('a repeated URL is a duplicate verdict, not a second row', () => {
  const fx = fixture(HEADER_10, [
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Applied | ❌ | — | seed | https://acme.test/jobs/7 |',
  ]);
  try {
    const before = fx.read();
    // Tracking params are stripped by url-key.mjs, so these are the same posting.
    const run = add(fx.env, ['--company', 'Acme', '--role', 'Engineer', '--url', 'https://acme.test/jobs/7?utm_source=feed']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.verdict, 'duplicate');
    assert.equal(run.doc.num, 1);
    assert.equal(run.doc.matchedBy, 'url');
    assert.equal(fx.read(), before);
  } finally {
    fx.cleanup();
  }
});

test('without a URL, the same company + fuzzy role is a duplicate', () => {
  const fx = fixture(HEADER_9, [
    '| 1 | 2026-01-01 | Acme, Inc. | Senior Data Engineer | 4.0/5 | Applied | ❌ | — | seed |',
  ]);
  try {
    const before = fx.read();
    const run = add(fx.env, ['--company', 'acme inc', '--role', 'Data Engineer (Senior)']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.verdict, 'duplicate');
    assert.equal(run.doc.matchedBy, 'company+role');
    assert.equal(fx.read(), before);
  } finally {
    fx.cleanup();
  }
});

test('a conflicting URL proves a different posting, so no duplicate is claimed', () => {
  const fx = fixture(HEADER_10, [
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Applied | ❌ | — | seed | https://acme.test/jobs/7 |',
  ]);
  try {
    const run = add(fx.env, ['--company', 'Acme', '--role', 'Engineer', '--url', 'https://acme.test/jobs/9']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.verdict, 'created');
    assert.equal(dataRows(fx.read()).length, 2);
  } finally {
    fx.cleanup();
  }
});

test('--update-on-match rewrites only the supplied fields of the matched row', () => {
  const fx = fixture(HEADER_10, [
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Applied | ❌ | — | seed | https://acme.test/jobs/7 |',
  ]);
  try {
    const run = add(fx.env, [
      '--company', 'Acme', '--role', 'Engineer', '--url', 'https://acme.test/jobs/7',
      '--note', 'recruiter call', '--update-on-match',
    ]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.verdict, 'updated');
    assert.deepEqual(run.doc.changedFields, ['notes']);
    const rows = dataRows(fx.read());
    assert.equal(rows.length, 1);
    assert.match(rows[0], /\| seed; recruiter call \|/);
  } finally {
    fx.cleanup();
  }
});

test('an extra column in the header is preserved on the new row', () => {
  const fx = fixture([
    '| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|----------|-------|--------|-----|--------|-------|',
  ], [
    '| 1 | 2026-01-01 | Acme | Engineer | Berlin | 4.0/5 | Applied | ❌ | — | seed |',
  ]);
  try {
    const run = add(fx.env, ['--company', 'Beta', '--role', 'Analyst']);
    assert.equal(run.code, 0, run.stderr);
    const content = fx.read();
    const rows = dataRows(content);
    const headerCells = content.split('\n').find((line) => line.startsWith('| #')).split('|').length;
    // Same cell count as the header: a narrower row is unparseable by every
    // header-driven reader, which is how applications became unaddressable.
    assert.equal(rows[0].split('|').length, headerCells);
    const cells = rows[0].split('|').map((cell) => cell.trim());
    // Index 1 is #, 2 Date, 3 Company, 4 Role, 5 Location.
    assert.equal(cells[4], 'Analyst');
    assert.equal(cells[5], '—');
  } finally {
    fx.cleanup();
  }
});

test('a non-canonical status is refused before the tracker is touched', () => {
  const fx = fixture(HEADER_9);
  try {
    const before = fx.read();
    const run = add(fx.env, ['--company', 'Acme', '--role', 'Engineer', '--status', 'nonsense']);
    assert.equal(run.code, 1);
    assert.equal(run.doc.code, 'invalid-state');
    assert.equal(fx.read(), before);
  } finally {
    fx.cleanup();
  }
});

test('a missing required field is a usage error with no write', () => {
  const fx = fixture(HEADER_9);
  try {
    const before = fx.read();
    const run = add(fx.env, ['--company', 'Acme']);
    assert.equal(run.code, 1);
    assert.equal(run.doc.code, 'usage');
    assert.equal(fx.read(), before);
  } finally {
    fx.cleanup();
  }
});

test('a held tracker lock surfaces as exit 4 (the retryable path)', async () => {
  const fx = fixture(HEADER_9);
  const lockDir = fx.env.CAREER_OPS_TRACKER_LOCK;
  const lock = await acquireTrackerLock(lockDir, {
    timeoutMs: 2_000, retryMs: 20, staleMs: 5_000, tracker: fx.tracker,
  });
  try {
    const before = fx.read();
    const run = add(fx.env, ['--company', 'Acme', '--role', 'Engineer'], {
      CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '150',
    });
    assert.equal(run.code, 4, `${run.stdout}${run.stderr}`);
    assert.equal(run.doc.code, 'lock-timeout');
    assert.equal(fx.read(), before);
  } finally {
    lock.release();
    fx.cleanup();
  }
});

test('no separator row means no insert point — refuse instead of guessing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-tracker-add-broken-'));
  const tracker = join(dir, 'applications.md');
  writeFileSync(tracker, '# Applications Tracker\n\nNo table here yet.\n');
  try {
    const run = add({ CAREER_OPS_TRACKER: tracker, CAREER_OPS_TRACKER_DB: join(dir, 'x.db') }, [
      '--company', 'Acme', '--role', 'Engineer',
    ]);
    assert.equal(run.code, 1);
    assert.equal(run.doc.code, 'no-insert-point');
    assert.equal(readFileSync(tracker, 'utf-8'), '# Applications Tracker\n\nNo table here yet.\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing tracker file is exit 2 (404), not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-tracker-add-missing-'));
  try {
    const run = add({ CAREER_OPS_TRACKER: join(dir, 'nope.md') }, ['--company', 'Acme', '--role', 'Engineer']);
    assert.equal(run.code, 2);
    assert.equal(run.doc.code, 'no-tracker');
    assert.equal(existsSync(join(dir, 'nope.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the suite never touched the real tracker', () => {
  assert.equal(realTrackerHash(), REAL_HASH_BEFORE);
});
