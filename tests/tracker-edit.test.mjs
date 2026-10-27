/**
 * tracker-edit.mjs — the single-row field editor behind PATCH /api/tracker/[id].
 *
 * The properties that matter, and why each one is asserted here rather than
 * trusted:
 *   - only the named cells change, so an edit never rewrites a row's other
 *     columns (the tracker is the user's data; a writer that normalizes
 *     everything on the way through keeps producing diffs nobody asked for);
 *   - a status change appends the SAME transition-ledger line set-status.mjs
 *     writes, otherwise funnel-velocity.mjs silently stops seeing this writer's
 *     transitions;
 *   - a field the tracker has no column for is refused rather than dropped;
 *   - an unknown/duplicate row is a not-found/conflict, never "the first match".
 *
 * Fixtures live in a temp dir via CAREER_OPS_TRACKER; the real tracker is hashed
 * before and after the file to prove it was never touched.
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

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REAL_TRACKER = join(ROOT, 'data', 'applications.md');

/**
 * Hash of the user's real tracker, or null when this checkout has none.
 *
 * @returns {string|null}
 */
function realTrackerHash() {
  try {
    return createHash('sha256').update(readFileSync(REAL_TRACKER)).digest('hex');
  } catch {
    return null;
  }
}

const REAL_HASH_BEFORE = realTrackerHash();

const HEADER = [
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
];

// The user's real tracker layout carries a Planned column between Status and
// PDF; --planned writes must land there and nowhere else.
const HEADER_PLANNED = [
  '| # | Date | Company | Via | Role | Score | Status | Planned | PDF | Report | Notes | URL |',
  '|---|------|---------|-----|------|-------|--------|---------|-----|--------|-------|-----|',
];

/**
 * A throwaway workspace holding one tracker file (and its status ledger).
 *
 * @param {string[]} rows - Data rows.
 * @param {string[]} [header] - Header + separator lines (defaults to the legacy 9-column layout).
 * @returns {{dir: string, tracker: string, env: Record<string,string>, read: () => string, ledger: () => string, cleanup: () => void}}
 */
function fixture(rows, header = HEADER) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-tracker-edit-'));
  const tracker = join(dir, 'applications.md');
  writeFileSync(tracker, ['# Applications Tracker', '', ...header, ...rows, ''].join('\n'));
  return {
    dir,
    tracker,
    env: {
      CAREER_OPS_TRACKER: tracker,
      CAREER_OPS_TRACKER_DB: join(dir, 'applications.db'),
      CAREER_OPS_TRACKER_LOCK: join(dir, 'career-ops-merge-tracker-edit.lock'),
      CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '3000',
      CAREER_OPS_TRACKER_LOCK_RETRY_MS: '20',
    },
    read: () => readFileSync(tracker, 'utf-8'),
    ledger: () => (existsSync(join(dir, 'status-log.tsv'))
      ? readFileSync(join(dir, 'status-log.tsv'), 'utf-8')
      : ''),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Run tracker-edit.mjs against a fixture.
 *
 * @param {Record<string,string>} env
 * @param {string[]} args
 * @returns {{code: number|null, stdout: string, stderr: string, doc: any}}
 */
function edit(env, args) {
  const result = spawnSync(process.execPath, [join(ROOT, 'tracker-edit.mjs'), ...args, '--json'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const stdout = result.stdout ?? '';
  return { code: result.status, stdout, stderr: result.stderr ?? '', doc: lastJson(stdout) };
}

/**
 * The last JSON document on stdout.
 *
 * @param {string} stdout
 * @returns {any}
 */
function lastJson(stdout) {
  const lines = String(stdout ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim().startsWith('{')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      // not the document start
    }
  }
  return null;
}

test('edits only the named cells and leaves the rest of the row intact', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | [1](reports/001-acme.md) | seed note |',
  ]);
  try {
    const run = edit(fx.env, ['--row', '1', '--score', '4.6/5', '--company', 'Acme Labs']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.changed, true);
    assert.deepEqual([...run.doc.changedFields].sort(), ['company', 'score']);
    assert.equal(
      fx.read().includes('| 1 | 2026-01-01 | Acme Labs | Engineer | 4.6/5 | Evaluated | ❌ | [1](reports/001-acme.md) | seed note |'),
      true,
      fx.read(),
    );
  } finally {
    fx.cleanup();
  }
});

test('a status change is validated, written, and appended to the transition ledger', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | seed |',
  ]);
  try {
    const run = edit(fx.env, ['--row', '1', '--status', 'interview', '--source', 'web']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.oldStatus, 'Evaluated');
    assert.equal(run.doc.newStatus, 'Interview');
    assert.equal(run.doc.statusLogged, true);
    assert.match(fx.read(), /\| Interview \|/);
    const ledger = fx.ledger().trim().split('\t');
    assert.deepEqual(ledger.slice(0, 5), ['1', ledger[1], 'Evaluated', 'Interview', 'web']);
    assert.match(ledger[1], /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    fx.cleanup();
  }
});

test('a non-status edit appends nothing to the ledger', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | seed |',
  ]);
  try {
    const run = edit(fx.env, ['--row', '1', '--note', 'touched']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.changed, true);
    assert.equal(fx.ledger(), '');
  } finally {
    fx.cleanup();
  }
});

test('re-running the same edit is a no-op, not a rewrite', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | seed |',
  ]);
  try {
    const first = edit(fx.env, ['--row', '1', '--note', 'touched']);
    assert.equal(first.code, 0, first.stderr);
    const afterFirst = fx.read();
    const second = edit(fx.env, ['--row', '1', '--note', 'touched']);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.doc.changed, false);
    assert.deepEqual(second.doc.changedFields, []);
    assert.equal(fx.read(), afterFirst);
  } finally {
    fx.cleanup();
  }
});

test('a non-canonical status is refused without touching the file', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | seed |',
  ]);
  try {
    const before = fx.read();
    const run = edit(fx.env, ['--row', '1', '--status', 'nonsense']);
    assert.equal(run.code, 1);
    assert.equal(run.doc.code, 'invalid-state');
    assert.equal(fx.read(), before);
  } finally {
    fx.cleanup();
  }
});

test('a field the tracker has no column for is refused, not silently dropped', () => {
  // The 9-column layout has no Via column.
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | seed |',
  ]);
  try {
    const before = fx.read();
    const run = edit(fx.env, ['--row', '1', '--via', 'Agency']);
    assert.equal(run.code, 1);
    assert.equal(run.doc.code, 'no-column');
    assert.deepEqual(run.doc.missingColumns, ['via']);
    assert.equal(fx.read(), before);
  } finally {
    fx.cleanup();
  }
});

test('an unknown row number is exit 2 (404) and a body with no fields is exit 1', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | seed |',
  ]);
  try {
    const missing = edit(fx.env, ['--row', '42', '--note', 'x']);
    assert.equal(missing.code, 2);
    assert.equal(missing.doc.code, 'not-found');

    const empty = edit(fx.env, ['--row', '1']);
    assert.equal(empty.code, 1);
    assert.equal(empty.doc.code, 'usage');

    const badFlag = edit(fx.env, ['--row', '1', '--nonsense', 'x']);
    assert.equal(badFlag.code, 1);
    assert.equal(badFlag.doc.code, 'usage');
  } finally {
    fx.cleanup();
  }
});

test('a duplicate row number is refused rather than resolved to the first match', () => {
  // #1704: a stale # reused across two rows makes "the first match" a coin flip
  // on which application gets edited.
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | first |',
    '| 1 | 2026-01-02 | Beta | Analyst | 3.0/5 | Evaluated | ❌ | — | second |',
  ]);
  try {
    const before = fx.read();
    const run = edit(fx.env, ['--row', '1', '--note', 'x']);
    assert.equal(run.code, 3);
    assert.equal(run.doc.code, 'ambiguous');
    assert.equal(fx.read(), before);
  } finally {
    fx.cleanup();
  }
});

test('planned: writes the date, clears with "", rejects invalid dates', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | — | Engineer | 4.0/5 | Evaluated | — | ❌ | — | seed | https://example.com/1 |',
  ], HEADER_PLANNED);
  try {
    const run = edit(fx.env, ['--row', '1', '--planned', '2026-10-27']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.changed, true);
    assert.deepEqual(run.doc.changedFields, ['planned']);
    assert.match(fx.read(), /\| Evaluated \| 2026-10-27 \| ❌/);
    // planned is not a status transition — the ledger must stay untouched.
    assert.equal(fx.ledger(), '');

    const bad = edit(fx.env, ['--row', '1', '--planned', '2026-13-45']);
    assert.equal(bad.code, 1);
    assert.equal(bad.doc.code, 'invalid-field');
    assert.match(fx.read(), /\| Evaluated \| 2026-10-27 \| ❌/, 'invalid date must not rewrite the file');

    const clear = edit(fx.env, ['--row', '1', '--planned', '']);
    assert.equal(clear.code, 0, clear.stderr);
    assert.equal(clear.doc.changed, true);
    assert.match(fx.read(), /\| Evaluated \| {1,2}\| ❌/, 'clear must empty the Planned cell');

    // The tracker's own empty-cell sentinel clears as well — a PowerShell
    // caller cannot pass "" to a native command, and — is what unplanned rows
    // historically carry.
    const sent = edit(fx.env, ['--row', '1', '--planned', '2026-11-01']);
    assert.equal(sent.code, 0, sent.stderr);
    const dashClear = edit(fx.env, ['--row', '1', '--planned', '—']);
    assert.equal(dashClear.code, 0, dashClear.stderr);
    assert.equal(dashClear.doc.changed, true);
    assert.match(fx.read(), /\| Evaluated \| {1,2}\| ❌/, '— must empty the Planned cell too');
    // A whitespace-only value normalizes to the same clear, not an invalid date.
    const blank = edit(fx.env, ['--row', '1', '--planned', '  ']);
    assert.equal(blank.code, 0, blank.stderr);
    assert.equal(blank.doc.changed, false, 'already-cleared cell stays cleared');
  } finally {
    fx.cleanup();
  }
});

test('planned: refused with no-column when the tracker has no Planned column', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | seed |',
  ]);
  try {
    const before = fx.read();
    const run = edit(fx.env, ['--row', '1', '--planned', '2026-10-27']);
    assert.equal(run.code, 1);
    assert.equal(run.doc.code, 'no-column');
    assert.deepEqual(run.doc.missingColumns, ['planned']);
    assert.equal(fx.read(), before);
  } finally {
    fx.cleanup();
  }
});

test('the suite never touched the real tracker', () => {
  assert.equal(realTrackerHash(), REAL_HASH_BEFORE);
});
