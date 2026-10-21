// #3162: the workspace root must survive a sibling test that legitimately sets
// CAREER_OPS_TRACKER for its own fixture. Before the fix, generate-pdf.mjs
// froze the root at import time, so an import landing inside that window
// anchored the containment guard to another test's temp directory for the rest
// of the process — the guard then refused valid repo paths, intermittently and
// only under the full suite (occurrence 6 of #3162 named the temp dir outright).
import { mkdtempSync, mkdirSync, rmdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\ngenerate-pdf-workspace-root.test.mjs — the containment root is read at use time (#3162)');

const original = process.env.CAREER_OPS_TRACKER;
const foreign = mkdtempSync(join(tmpdir(), 'cops-foreign-'));
mkdirSync(join(foreign, 'output'), { recursive: true });
writeFileSync(join(foreign, 'applications.md'), '# Applications Tracker\n');

let failures = 0;
let mod;
try {
  // Poison the environment the way a sibling fixture does, THEN import.
  process.env.CAREER_OPS_TRACKER = join(foreign, 'applications.md');
  mod = await import('../generate-pdf.mjs');
  // Restore exactly as that sibling does in its finally.
  if (original === undefined) delete process.env.CAREER_OPS_TRACKER;
  else process.env.CAREER_OPS_TRACKER = original;

  // A path inside the real repo must be accepted now that the variable is back.
  const repoPath = join(ROOT, 'output', 'workspace-root-probe.html');
  try {
    const rel = mod.workspaceRelativeManifestPath(repoPath);
    if (typeof rel === 'string' && rel.length > 0 && !rel.startsWith('..')) {
      pass('a repo path resolves against the real workspace after a sibling restored CAREER_OPS_TRACKER');
    } else {
      fail(`repo path resolved to "${rel}" — the root is still anchored to the foreign fixture (#3162)`);
      failures++;
    }
  } catch (err) {
    fail(`repo path rejected after restore: ${err.message}`);
    failures++;
  }
} finally {
  if (original === undefined) delete process.env.CAREER_OPS_TRACKER;
  else process.env.CAREER_OPS_TRACKER = original;
}

// #1135：D:\workspace 迁移成指向 F:\workspace 的 junction 之后，web 端派发的定制
// 简历渲染全部被拒。守卫先用 path.relative() 做词法比较，跨盘符就立即 return false，
// 根本走不到下面的 realpath 比对——同一个目录的两种拼写被判成越界。
// 已有用例覆盖「符号链接真的逃逸」（必须拒绝），这里补的是「链接只是别名」（必须放行）：
// root 用真实路径，候选路径经 junction 拼写，词法上读作 ..\{别名}\out.pdf，
// realpath 之后两边落在同一个目录。
console.log('\ngenerate-pdf 工作区守卫 — junction 别名不是逃逸 (#1135)');
const realDir = realpathSync(mkdtempSync(join(tmpdir(), 'cops-guard-real-')));
const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'cops-guard-outside-')));
const aliasDir = join(dirname(realDir), `cops-guard-alias-${process.pid}-${Date.now()}`);
try {
  symlinkSync(realDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');

  const viaAlias = join(aliasDir, 'out.pdf');
  if (mod.isWorkspaceOutputPath(viaAlias, realDir)) {
    pass('经 junction 拼写的输出路径被判为工作区内（同一目录的不同写法）');
  } else {
    fail(`经 junction 拼写的输出路径被拒：${viaAlias} —— 守卫仍在用词法比较判越界 (#1135)`);
    failures++;
  }

  // 反面：真正落在工作区外的路径必须继续被拒，别名放行不能顺手把逃逸也放进来。
  const realEscape = join(outsideDir, 'out.pdf');
  if (!mod.isWorkspaceOutputPath(realEscape, realDir)) {
    pass('真正落在工作区之外的输出路径仍被拒绝');
  } else {
    fail(`工作区之外的输出路径被放行：${realEscape} —— 包含性守卫失效`);
    failures++;
  }
} finally {
  // rmdirSync 只摘掉链接本身，不会跟进目标目录删除其中的文件。
  try { rmdirSync(aliasDir); } catch { /* 创建失败时无链接可摘 */ }
  rmSync(realDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
