#!/usr/bin/env node

/**
 * validate-system-paths-coverage.mjs — structural coverage check for the
 * auto-updater layer split.
 *
 * Every tracked file in the repo must be covered by either SYSTEM_PATHS
 * (system layer, fetched on `update-system.mjs apply`) or USER_PATHS
 * (user-owned, never touched). Anything else is a coverage gap: it
 * lives in the repo but the auto-updater won't propagate it to
 * clients on `apply`. That breaks them on the next test run.
 *
 * Run: node validate-system-paths-coverage.mjs
 * Exit 0 = clean. Exit 1 = orphan files listed.
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, posix } from 'path';
import { fileURLToPath } from 'url';
import { extractArrayFromSource, localUserPaths, LOCAL_PATHS_FILE } from './update-system.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(ROOT, 'update-system.mjs');

if (!existsSync(sourcePath)) {
  console.error('FAIL: update-system.mjs not found');
  process.exit(1);
}

const source = readFileSync(sourcePath, 'utf-8');

const SYSTEM_PATHS = extractArrayFromSource(source, 'SYSTEM_PATHS');
const USER_PATHS = extractArrayFromSource(source, 'USER_PATHS');

if (SYSTEM_PATHS.length === 0 || USER_PATHS.length === 0) {
  console.error('FAIL: SYSTEM_PATHS or USER_PATHS not found in update-system.mjs');
  process.exit(1);
}
// Paths a fork declared as its own in the gitignored local file (#2421).
// Without these, a tracked fork-local file (a nightly runner, an .mcp.json)
// is an orphan here and fails the whole suite, and the only fix is to edit
// USER_PATHS inside update-system.mjs — the file `apply` overwrites and git
// re-merges on every sync. A malformed declaration fails loudly: this guard
// exists to be trustworthy, so it must never fall back to a partial view.
let LOCAL_PATHS;
try {
  LOCAL_PATHS = localUserPaths(ROOT);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}

const ALL_PATHS = [...SYSTEM_PATHS, ...USER_PATHS, ...LOCAL_PATHS];

const EXCLUDES = [
  '.coderabbit.yaml',
  '.editorconfig',
  '.envrc',
  '.npmignore',
  '.release-please-manifest.json',
  'release-please-config.json',
  'renovate.json',
  'flake.lock',
  'flake.nix',
  'batch/logs/.gitkeep',
  'batch/tracker-additions/.gitkeep',
  'interview-prep/.gitkeep',
];

// .gitignore is excluded from the manifest but NOT from installs, and the
// difference is the whole of #2756. It cannot join SYSTEM_PATHS: it is the one
// system file users also write to, so the raw `git checkout` that ships every
// other path would delete their own rules. It reaches installs by a different
// route instead — update-system.mjs's reconcileGitignore(), which appends the
// system-owned rules an install is missing and touches nothing else.
//
// Kept in its own group rather than folded in above, because the entries above
// genuinely never reach an install and this one does. Reading it as the same
// kind of exclusion is what let 43 releases' worth of new ignore rules stay in
// this repository only, leaving a candidate's CV stageable in every fork.
const RECONCILED_NOT_CHECKED_OUT = ['.gitignore'];

// Trees that live in the repo but deliberately OUTSIDE the updater's world:
// web/ is the experimental web UI — its own release-please component, never
// shipped by update-system.mjs, never in the npm package. Excluding it here is
// part of that isolation contract, not a coverage gap.
const EXCLUDE_PREFIXES = ['web/'];

function coveredBy(file, paths) {
  return paths.some((path) =>
    path.endsWith('/') ? file.startsWith(path) : file === path,
  );
}

function covered(file) {
  // If explicitly excluded, it is covered
  if (EXCLUDES.includes(file)) return true;
  if (RECONCILED_NOT_CHECKED_OUT.includes(file)) return true;
  if (EXCLUDE_PREFIXES.some((p) => file.startsWith(p))) return true;

  return coveredBy(file, ALL_PATHS);
}

// A fork-local file (config/local-paths.txt) is declared "never updated". A
// SYSTEM file importing one means the system layer DEPENDS on something `apply`
// will never ship: the importer arrives, the import does not, and every install
// throws ERR_MODULE_NOT_FOUND. status-log.mjs shipped exactly this way — a repo
// script imported by stats.mjs, yet parked on a fork-local declaration, so the
// coverage check above stayed green while the dependency was broken for anyone
// who ran `apply`. Declaring a system file fork-local to silence that check is
// the move this guard exists to reject.
const SCRIPT_RE = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/;
const IMPORT_SPEC_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)(['"])([^'"]+)\1/g;

/**
 * Which system files import a fork-local file.
 *
 * Pure and injectable so `--self-test` can pin the behaviour instead of relying
 * on today's tree: `readFile` returns the file's source, or '' when unreadable.
 * Only relative specifiers are resolved (a package import can never name a repo
 * file), and directory declarations match by prefix, same as `covered`.
 *
 * @param {{systemFiles: string[], localPaths: string[], readFile: (rel: string) => string}} input
 * @returns {{importer: string, imported: string}[]}
 */
function layerLeaks({ systemFiles, localPaths, readFile }) {
  const locals = localPaths.map((p) => p.replace(/\\/g, '/'));
  const isLocal = (rel) => locals.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
  const leaks = [];
  for (const file of systemFiles) {
    const source = readFile(file);
    if (!source) continue;
    for (const match of source.matchAll(IMPORT_SPEC_RE)) {
      const spec = match[2];
      if (!spec.startsWith('.')) continue;
      const imported = posix.normalize(posix.join(posix.dirname(file), spec));
      if (isLocal(imported)) leaks.push({ importer: file, imported });
    }
  }
  return leaks;
}

/**
 * Drop the layer leaks a baseline already owns.
 *
 * @param {{importer: string, imported: string}[]} leaks
 * @param {Set<string>} baseline - keys of the form `importer -> imported`.
 * @returns {{importer: string, imported: string}[]} Leaks the baseline does not name.
 */
function unbaselinedLeaks(leaks, baseline) {
  return leaks.filter((leak) => !baseline.has(leakKey(leak)));
}

const leakKey = (leak) => `${leak.importer} -> ${leak.imported}`;

if (process.argv.includes('--self-test')) {
  console.log('Running validate-system-paths-coverage.mjs self-tests...');
  
  const assert = (condition, message) => {
    if (!condition) {
      console.error(`FAIL: ${message}`);
      process.exit(1);
    }
  };

  // Test explicitly excluded files
  assert(covered('.gitignore') === true, '.gitignore must be covered (excluded)');
  assert(covered('.coderabbit.yaml') === true, '.coderabbit.yaml must be covered (excluded)');
  assert(covered('.editorconfig') === true, '.editorconfig must be covered (excluded, #1438/#1613)');

  // Test exact matches in SYSTEM_PATHS / USER_PATHS
  assert(covered('CLAUDE.md') === true, 'CLAUDE.md must be covered (exact match)');
  assert(covered('.claude/settings.json') === true, '.claude/settings.json must be covered (USER_PATHS exact match, #1408)');
  assert(covered('.claude/hooks/pre-push-backup.sh') === true, '.claude/hooks/ scripts must be covered (USER_PATHS dir prefix match, same class as #1408)');

  // Test directory prefix matches (which end in '/')
  assert(covered('providers/justjoin.mjs') === true, 'providers/justjoin.mjs must be covered (dir prefix match)');

  // Test sibling mismatch (strict prefix match)
  assert(covered('providers-sibling/justjoin.mjs') === false, 'providers-sibling/justjoin.mjs must NOT be covered');
  assert(covered('web/package.json') === true, 'web/ tree must be covered (isolation-contract prefix exclude)');
  assert(covered('web-dashboard/index.html') === false, 'web-dashboard/ must NOT ride the web/ prefix exclude');
  assert(covered('.npmignore') === true, '.npmignore must be covered (excluded)');

  // Test unrelated file
  assert(covered('untracked-orphan-file-xyz.js') === false, 'untracked-orphan-file-xyz.js must NOT be covered');

  // Test the layer-leak guard: a system file importing a fork-local file is a
  // leak; a package import, a system-to-system import and a sibling that merely
  // shares a prefix are not. Stubbing readFile keeps the assertions true no
  // matter what today's tree happens to contain.
  const leakSources = {
    'stats.mjs': "import { x } from './status-log.mjs';",
    'clean.mjs': "import fs from 'node:fs';\nimport { y } from './helper.mjs';",
    'prefix.mjs': "import { z } from './lib2/other.mjs';",
  };
  const leakRead = (rel) => leakSources[rel] ?? '';
  const leaks = layerLeaks({
    systemFiles: Object.keys(leakSources),
    localPaths: ['status-log.mjs', 'lib2/'],
    readFile: leakRead,
  });
  assert(
    leaks.length === 2 && leaks.some((l) => l.imported === 'status-log.mjs'),
    'a system file importing a fork-local file must be reported as a layer leak',
  );
  assert(
    layerLeaks({ systemFiles: ['clean.mjs'], localPaths: ['status-log.mjs'], readFile: leakRead }).length === 0,
    'package and system-to-system imports must NOT be reported as layer leaks',
  );
  assert(
    layerLeaks({ systemFiles: ['prefix.mjs'], localPaths: ['lib/'], readFile: leakRead }).length === 0,
    'a sibling directory sharing a prefix must NOT be reported as a layer leak',
  );
  // The baseline may suppress known debt but never a new pairing — otherwise the
  // guard becomes a rubber stamp the moment it has one entry.
  const baselined = unbaselinedLeaks(leaks, new Set(['stats.mjs -> status-log.mjs']));
  assert(
    baselined.length === 1 && baselined[0].imported === 'lib2/other.mjs',
    'the baseline must suppress only the pairing it names',
  );
  assert(
    unbaselinedLeaks(leaks, new Set(['stats.mjs -> status-log.mjs', 'prefix.mjs -> lib2/other.mjs'])).length === 0,
    'a fully baselined leak set must produce no failures',
  );

  console.log('ALL SELF-TESTS PASSED');
  process.exit(0);
}

let tracked;
try {
  tracked = execFileSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf-8',
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
} catch (err) {
  console.error('FAIL: git ls-files failed:', err.message);
  process.exit(1);
}

// An empty file list is NOT "nothing to check" — it means this run could not
// inspect anything, and reporting success would make the guard a no-op.
//
// That is exactly what happened for as long as this check has existed. test-all
// runs the scripts from a throwaway copy created *inside* the repo, and
// `git ls-files` from an untracked subdirectory returns zero paths. So CI printed
// "OK: 0 tracked files covered" and exited 0 while the real tree had an
// unregistered top-level file. A file missing from SYSTEM_PATHS is not cosmetic:
// `update-system` never ships it, so every user who updates silently loses it.
// This bug class has landed five times (#649, #704, .editorconfig, and twice
// since) and the guard meant to stop it was green throughout.
//
// A check that cannot look must fail, not pass.
if (tracked.length === 0) {
  console.error('FAIL: git ls-files returned no paths — this run could not inspect anything.');
  console.error('');
  console.error('Run this from the repository root. An empty listing usually means the');
  console.error('script was invoked from an untracked directory (a temp copy, a fixture');
  console.error('dir), where git reports nothing and the coverage check is meaningless.');
  process.exit(1);
}

const orphans = tracked.filter((f) => !covered(f));

if (orphans.length > 0) {
  console.error('Coverage gap — tracked files not in SYSTEM_PATHS or USER_PATHS:');
  for (const orphan of orphans) console.error(`  ${orphan}`);
  console.error('');
  console.error('Add each path to update-system.mjs SYSTEM_PATHS (if system layer)');
  console.error('or USER_PATHS (if user-owned), then re-run this check.');
  process.exit(1);
}

// Layer leak: a SYSTEM file importing a fork-local file. Coverage alone cannot
// see this — every path is claimed, yet the system layer depends on a file
// `apply` will never ship. status-log.mjs sat exactly here: a repo script
// imported by stats.mjs, declared fork-local, so this check was green.
const systemFiles = tracked.filter((f) => SCRIPT_RE.test(f) && coveredBy(f, SYSTEM_PATHS));
const leaks = layerLeaks({
  systemFiles,
  localPaths: LOCAL_PATHS,
  readFile: (rel) => {
    try {
      return readFileSync(join(ROOT, rel), 'utf-8');
    } catch {
      return '';
    }
  },
});

// Baseline: layer leaks that already existed when this guard was added. This
// fork updates by `git merge upstream`, not `apply` (ADR-0022), so these are
// deliberate — `local/` is fork-only by definition, `lib/zh-jobs.mjs` and
// `lib/log-checkup.mjs` are this fork's own system files. The list may SHRINK,
// never grow: a pairing not named here fails the check, which is what stops the
// next status-log.mjs from hiding behind a fork-local declaration.
const LAYER_LEAK_BASELINE = new Set([
  'analyze-patterns.mjs -> lib/log-checkup.mjs',
  'browser-extract.mjs -> lib/zh-jobs.mjs',
  'browser-extract.mjs -> bsk-extract.mjs',
  'scan.mjs -> local/scan-dedup.mjs',
  'tests/bsk-extract.test.mjs -> bsk-extract.mjs',
  'tests/bsk-extract.test.mjs -> lib/zh-jobs.mjs',
  'tests/checkup-ledger.test.mjs -> lib/log-checkup.mjs',
  'tests/login-check.test.mjs -> lib/login-check.mjs',
  'tests/zh-collect.test.mjs -> zh-collect.mjs',
  'tests/zh-salary-parse-parity.test.mjs -> bsk-extract.mjs',
  'url-key.mjs -> local/dedup-params.mjs',
]);

const newLeaks = unbaselinedLeaks(leaks, LAYER_LEAK_BASELINE);
const staleBaseline = [...LAYER_LEAK_BASELINE].filter((key) => !leaks.some((leak) => leakKey(leak) === key));

if (newLeaks.length > 0) {
  console.error('Layer leak — a SYSTEM file imports a fork-local file:');
  for (const leak of newLeaks) console.error(`  ${leakKey(leak)}`);
  console.error('');
  console.error('`apply` ships the importer but never the import, so every install breaks.');
  console.error(`Move the imported file into update-system.mjs SYSTEM_PATHS and out of ${LOCAL_PATHS_FILE}.`);
  process.exit(1);
}

// Not a failure: a baseline entry that no longer leaks means someone fixed it.
// Printed so the list gets pruned instead of silently outliving its reasons.
for (const key of staleBaseline) console.error(`note: baseline entry no longer leaks, prune it: ${key}`);

console.log(`OK: ${tracked.length} tracked files covered by SYSTEM_PATHS or USER_PATHS`);
process.exit(0);
