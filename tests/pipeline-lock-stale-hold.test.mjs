// Regression: a lock whose owner.json names a pid that kill(pid, 0) believes
// alive was NEVER recoverable — however old the hold. On Windows that pins a
// wedged lock forever, two ways: PIDs are reused (the pid in a 30-hour-old
// owner.json can belong to an unrelated live process when checked) and
// kill(pid, 0) itself answers "alive" for some dead holders. Observed
// 2026-09-15: data/pipeline.md.lock, owner pid dead since the previous day,
// "alive:true", stale recovery disabled — reconcile-pipeline timed out for
// every caller until the lock was deleted by hand.
//
// The fix: liveness is trusted only within the hold ceiling
// (DEFAULT_MAX_HOLD_MS / CAREER_OPS_LOCK_MAX_HOLD_MS). The critical sections
// both locks (pipeline + tracker, which imports this verdict) guard are
// single-file read-modify-writes measured in seconds, so a hold older than the
// ceiling is a wedged or pid-reused holder no matter what kill(0) says.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lockRecoveryVerdict, maxHoldMs, DEFAULT_MAX_HOLD_MS, OWNERLESS_GRACE_MS,
  RECOVER_STALE, RECOVER_LIVE,
} from '../pipeline-lock.mjs';

const DEAD_PID = 2147483000; // not a live pid (same probe the older test uses)

function lockWithOwner(owner) {
  const root = mkdtempSync(join(tmpdir(), 'cops-lock-hold-'));
  const lockDir = join(root, 'pipeline.md.lock');
  mkdirSync(lockDir, { recursive: true });
  if (owner) {
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf-8');
  }
  return { root, lockDir, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

test('an "alive" holder whose hold outlived the ceiling is STALE (the 30-hour wedge)', () => {
  const { lockDir, cleanup } = lockWithOwner({
    pid: process.pid, // definitely alive by kill(0)
    token: 'wedge',
    started_at: ago(DEFAULT_MAX_HOLD_MS + MIN),
  });
  try {
    assert.equal(lockRecoveryVerdict(lockDir, 30_000), RECOVER_STALE);
  } finally {
    cleanup();
  }
});

test('an "alive" holder within the ceiling stays LIVE', () => {
  const { lockDir, cleanup } = lockWithOwner({
    pid: process.pid,
    token: 'fresh',
    started_at: ago(MIN),
  });
  try {
    assert.equal(lockRecoveryVerdict(lockDir, 30_000), RECOVER_LIVE);
  } finally {
    cleanup();
  }
});

test('an unparseable started_at stays LIVE (hold length unknown, no licence to delete)', () => {
  const { lockDir, cleanup } = lockWithOwner({
    pid: process.pid,
    token: 'torn-clock',
    started_at: 'not-a-timestamp',
  });
  try {
    assert.equal(lockRecoveryVerdict(lockDir, 30_000), RECOVER_LIVE);
  } finally {
    cleanup();
  }
});

test('CAREER_OPS_LOCK_MAX_HOLD_MS tightens the ceiling (floored at OWNERLESS_GRACE_MS)', () => {
  process.env.CAREER_OPS_LOCK_MAX_HOLD_MS = String(2 * MIN);
  try {
    assert.equal(maxHoldMs(), 2 * MIN);
    const { lockDir, cleanup } = lockWithOwner({
      pid: process.pid,
      token: 'tight',
      started_at: ago(3 * MIN), // beyond the 2-min override, inside the default
    });
    try {
      assert.equal(lockRecoveryVerdict(lockDir, 30_000), RECOVER_STALE);
    } finally {
      cleanup();
    }
  } finally {
    delete process.env.CAREER_OPS_LOCK_MAX_HOLD_MS;
    assert.equal(maxHoldMs(), DEFAULT_MAX_HOLD_MS);
  }
});

test('a dead-pid holder is still STALE immediately (pre-existing rule intact)', () => {
  const { lockDir, cleanup } = lockWithOwner({
    pid: DEAD_PID,
    token: 'crashed',
    started_at: ago(MIN), // young hold, dead owner — liveness rule alone decides
  });
  try {
    assert.equal(lockRecoveryVerdict(lockDir, 30_000), RECOVER_STALE);
  } finally {
    cleanup();
  }
});
