/**
 * tracker.mjs — the machine-readable half of the derived index: `history --json`,
 * `sync --json`, and the `health` pre-flight probe.
 *
 * The HTTP layer behind /api/tracker/{,sync,health} reads these documents
 * instead of parsing English off stderr, so what is pinned here is the CONTRACT:
 * one JSON document on stdout, printed last, with the fields the routes branch
 * on. In particular:
 *   - `sync --check` finding corruption is exit 1 but a valid DIAGNOSTIC
 *     document — the route answers 200 + issues, and only a sync that could not
 *     run at all is a 5xx;
 *   - `--check` writes nothing (no index file appears), which is the whole reason
 *     a pre-flight probe can be called before a write;
 *   - `health` reports the shared tracker lock, so a busy tracker reads as
 *     "retry shortly" rather than a broken checkout.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { rmSync } from './helpers.mjs';
import { acquireTrackerLock } from '../tracker-utils.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HEADER = [
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
];

/**
 * A throwaway workspace holding one tracker file.
 *
 * @param {string[]} rows - Data rows.
 * @returns {{dir: string, tracker: string, db: string, env: Record<string,string>, read: () => string, cleanup: () => void}}
 */
function fixture(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-tracker-json-'));
  const tracker = join(dir, 'applications.md');
  const db = join(dir, 'applications.db');
  writeFileSync(tracker, ['# Applications Tracker', '', ...HEADER, ...rows, ''].join('\n'));
  return {
    dir,
    tracker,
    db,
    env: {
      CAREER_OPS_TRACKER: tracker,
      CAREER_OPS_TRACKER_DB: db,
      CAREER_OPS_TRACKER_LOCK: join(dir, 'career-ops-merge-tracker-json.lock'),
      CAREER_OPS_TRACKER_LOCK_RETRY_MS: '20',
    },
    read: () => readFileSync(tracker, 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Run one tracker.mjs subcommand.
 *
 * @param {Record<string,string>} env
 * @param {string[]} args
 * @returns {{code: number|null, stdout: string, stderr: string, doc: any}}
 */
function tracker(env, args) {
  const result = spawnSync(process.execPath, [join(ROOT, 'tracker.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  const stdout = result.stdout ?? '';
  return { code: result.status, stdout, stderr: result.stderr ?? '', doc: lastJson(stdout) };
}

/**
 * The last JSON document on stdout — the CLIs print it after their diagnostics.
 *
 * @param {string} stdout
 * @returns {any}
 */
function lastJson(stdout) {
  const lines = String(stdout ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      // not the document start
    }
  }
  return null;
}

test('history --json returns the row identity and its observed transition events', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Applied | ❌ | — | seed |',
  ]);
  try {
    const run = tracker(fx.env, ['history', '--id', '1', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.num, 1);
    assert.equal(run.doc.company, 'Acme');
    assert.equal(run.doc.role, 'Engineer');
    assert.equal(Array.isArray(run.doc.events), true);
    assert.equal(run.doc.events.length, 1);
    assert.equal(run.doc.events[0].status, 'Applied');
  } finally {
    fx.cleanup();
  }
});

test('history --json for an unknown row reports code not-found, keeping exit 1', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Applied | ❌ | — | seed |',
  ]);
  try {
    const run = tracker(fx.env, ['history', '--id', '99', '--json']);
    // Exit 1 is the documented human-path behaviour (unchanged); the CODE is
    // what lets the HTTP layer answer 404 instead of 500.
    assert.equal(run.code, 1);
    assert.equal(run.doc.code, 'not-found');
  } finally {
    fx.cleanup();
  }
});

test('sync --check --json reports a clean tracker as ok with no issues and writes nothing', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Applied | ❌ | [1](reports/001-acme.md) | seed |',
  ]);
  try {
    const run = tracker(fx.env, ['sync', '--check', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.ok, true);
    assert.equal(run.doc.checkOnly, true);
    assert.deepEqual(run.doc.issues, []);
    assert.equal(run.doc.rowCount, 1);
    assert.equal(existsSync(fx.db), false, '--check must not build the index');
  } finally {
    fx.cleanup();
  }
});

test('sync --check --json surfaces corruption as issues while the markdown stays untouched', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | NotARealState | ❌ | — | seed |',
  ]);
  try {
    const before = fx.read();
    const run = tracker(fx.env, ['sync', '--check', '--json']);
    // Exit 1 is the documented "--check found problems"; the document is what the
    // route turns into 200 + data.issues rather than a 500.
    assert.equal(run.code, 1);
    assert.equal(run.doc.ok, false);
    assert.equal(run.doc.checkOnly, true);
    const codes = run.doc.issues.map((issue) => issue.code);
    assert.deepEqual(codes, ['unknown-status']);
    assert.equal(run.doc.issues[0].count, 1);
    assert.equal(fx.read(), before, '--check normalizes nothing on disk');
    assert.equal(existsSync(fx.db), false);
  } finally {
    fx.cleanup();
  }
});

test('sync --json (real run) builds the index and says so', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Applied | ❌ | — | seed |',
  ]);
  try {
    const run = tracker(fx.env, ['sync', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.ok, true);
    assert.equal(run.doc.wrote, true);
    assert.equal(run.doc.rowCount, 1);
    assert.equal(existsSync(fx.db), true);
  } finally {
    fx.cleanup();
  }
});

test('health --json reports paths, row count and a free lock', () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Applied | ❌ | — | seed |',
  ]);
  try {
    const run = tracker(fx.env, ['health', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.ok, true);
    assert.equal(run.doc.rowCount, 1);
    assert.equal(run.doc.lockHeld, false);
    assert.deepEqual(run.doc.issues, []);
    assert.equal(run.doc.dbPath, fx.db);
    // Read-only probe: health must not build the index as a side effect.
    assert.equal(existsSync(fx.db), false);
  } finally {
    fx.cleanup();
  }
});

test('health --json reports a held lock as not-ok and retryable', async () => {
  const fx = fixture([
    '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Applied | ❌ | — | seed |',
  ]);
  const lock = await acquireTrackerLock(fx.env.CAREER_OPS_TRACKER_LOCK, {
    timeoutMs: 2_000, retryMs: 20, staleMs: 5_000, tracker: fx.tracker,
  });
  try {
    const run = tracker(fx.env, ['health', '--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.doc.ok, false);
    assert.equal(run.doc.lockHeld, true);
    assert.equal(run.doc.retryable, true);
    assert.equal(run.doc.lockOwner.pid, process.pid);
  } finally {
    lock.release();
    fx.cleanup();
  }
});

test('a missing tracker is a no-tracker document, not a stack trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-tracker-json-missing-'));
  try {
    const env = { CAREER_OPS_TRACKER: join(dir, 'nope.md'), CAREER_OPS_TRACKER_DB: join(dir, 'nope.db') };
    const health = tracker(env, ['health', '--json']);
    assert.equal(health.code, 1);
    assert.equal(health.doc.code, 'no-tracker');

    const sync = tracker(env, ['sync', '--check', '--json']);
    assert.equal(sync.code, 1);
    assert.equal(sync.doc.code, 'no-tracker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
