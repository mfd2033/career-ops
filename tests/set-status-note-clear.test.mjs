// tests/set-status-note-clear.test.mjs — ADR-0079 undo-freeze note cleanup.
//
// --note-clear removes a previously appended Notes segment so the freeze undo
// restores the row to its PRE-freeze shape (status AND notes) — a leftover
// 「跟进 N 天无回复」 on a restored row would mislead. Same sandboxing pattern
// as mark-pdf-ready.test.mjs: CAREER_OPS_TRACKER + CAREER_OPS_TRACKER_LOCK.
//
// Auto-discovered by test-all.mjs (tests/**/*.test.mjs, #1440) — imported
// in-process, so this file must NEVER exit the process itself; only
// pass()/fail() from ./helpers.mjs.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nset-status.mjs — --note-clear (undo-freeze note cleanup)');

function makeSandbox(notes) {
  const dir = mkdtempSync(join(tmpdir(), 'co-noteclear-'));
  const tracker = join(dir, 'applications.md');
  writeFileSync(tracker, `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-09-21 | Acme | Backend Engineer | 4.2/5 | Discarded | ❌ | [1](../reports/001-acme.md) | ${notes} |
`);
  const lock = join(dir, 'career-ops-note-clear-test.lock');
  return { dir, tracker, lock };
}

function runSetStatus(args, sandbox) {
  try {
    const stdout = execFileSync(NODE, [join(ROOT, 'set-status.mjs'), ...args], {
      cwd: ROOT,
      env: { ...process.env, CAREER_OPS_TRACKER: sandbox.tracker, CAREER_OPS_TRACKER_LOCK: sandbox.lock },
      encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const notesCell = (sandbox) => {
  const row = readFileSync(sandbox.tracker, 'utf-8').split('\n').find((l) => l.startsWith('| 1 '));
  return row.split('|').map((s) => s.trim())[9];
};

const REASON = '跟进20天无回复';

// 1. 撤销冻结主场景：Discarded→Applied + 移除尾段原因 → 原状恢复
{
  const sb = makeSandbox(`Applied 2026-09-26; ${REASON}`);
  const r = runSetStatus(['--row', '1', 'Applied', '--note-clear', REASON, '--force', '--json'], sb);
  const ok = r.code === 0
    && notesCell(sb) === 'Applied 2026-09-26'
    && readFileSync(sb.tracker, 'utf-8').includes('| Applied |');
  ok ? pass('tail-segment clear + status revert restores pre-freeze row') : fail(`tail clear: code=${r.code} notes="${notesCell(sb)}" stderr=${r.stderr.slice(0, 200)}`);
}

// 2. 原因是整格（Notes 原本为空）→ 清成空
{
  const sb = makeSandbox(REASON);
  const r = runSetStatus(['--row', '1', 'Applied', '--note-clear', REASON, '--force', '--json'], sb);
  const ok = r.code === 0 && notesCell(sb) === '';
  ok ? pass('whole-cell clear empties Notes') : fail(`whole-cell: code=${r.code} notes="${notesCell(sb)}"`);
}

// 3. 中段移除（`; note; ` → `; `）
{
  const sb = makeSandbox(`Applied 2026-09-26; ${REASON}; reused JD`);
  const r = runSetStatus(['--row', '1', 'Applied', '--note-clear', REASON, '--force', '--json'], sb);
  const ok = r.code === 0 && notesCell(sb) === 'Applied 2026-09-26; reused JD';
  ok ? pass('middle-segment clear keeps neighbours intact') : fail(`middle: code=${r.code} notes="${notesCell(sb)}"`);
}

// 4. 幂等：段不存在时静默无操作（exit 0，Notes 不变）
{
  const sb = makeSandbox('Applied 2026-09-26');
  const r = runSetStatus(['--row', '1', 'Applied', '--note-clear', REASON, '--force', '--json'], sb);
  const ok = r.code === 0 && notesCell(sb) === 'Applied 2026-09-26';
  ok ? pass('clearing an absent segment is a silent no-op') : fail(`absent: code=${r.code} notes="${notesCell(sb)}"`);
}

// 5. 裸子串不误删：「回复」是「跟进20天无回复」的子串，但整段匹配才移除
{
  const sb = makeSandbox(`Applied 2026-09-26; ${REASON}`);
  const r = runSetStatus(['--row', '1', 'Applied', '--note-clear', '回复', '--force', '--json'], sb);
  const ok = r.code === 0 && notesCell(sb) === `Applied 2026-09-26; ${REASON}`;
  ok ? pass('bare substring does not remove') : fail(`substring: code=${r.code} notes="${notesCell(sb)}"`);
}

// 6. --note 与 --note-clear 互斥 → usage 错误
{
  const sb = makeSandbox('Applied 2026-09-26');
  const r = runSetStatus(['--row', '1', 'Applied', '--note', 'x', '--note-clear', 'y', '--force', '--json'], sb);
  const ok = r.code !== 0 && r.stderr.includes('mutually exclusive');
  ok ? pass('--note + --note-clear rejected as usage error') : fail(`conflict: code=${r.code} stderr=${r.stderr.slice(0, 200)}`);
}
