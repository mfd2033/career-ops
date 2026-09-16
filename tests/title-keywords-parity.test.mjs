// tests/title-keywords-parity.test.mjs — web/src/lib/core/title-keywords.mjs must
// agree with the repo-root title-keywords.mjs, rule for rule.
//
// WHY A COPY EXISTS: the root module's header states it is the single definition
// of title matching and deliberately not duplicated. The web copy exists anyway,
// for a reason the root module cannot see — Turbopack's root is pinned to web/
// and refuses modules outside it (web/next.config.mjs; same constraint as
// web/src/lib/profile-keywords.mjs and web/src/lib/core/url-key.mjs, the latter
// also a parity-guarded mirror). The browser-mode title gate runs in the
// EXTENSION path, inside the Next app, so it cannot import the root module; and
// the CLI cannot run that gate for it either, because browser discovery is
// extension-driven (ADR-0007) and must not spawn the scanner.
//
// The browser-mode gate reads the SAME portals.yml `title_filter` the CLI
// scanner reads (ADR-0029 决议 2 — 词表单一来源), so a drifted mirror would
// silently filter the Explorer by a different rule than the scanner. That is the
// "two answers to one question" failure the root module was extracted to end,
// and this repo has already paid for a drift once (tests/profile-keywords-parity).
//
// Lives in the ROOT suite, not web/tests/, for the reasons spelled out in
// tests/profile-keywords-parity.test.mjs: web-ci.yml runs `npm ci` inside web/
// only, so importing the root module resolves nothing there — and web-ci.yml is
// informative by design, while test-all.mjs is a required check.
//
// Compared BEHAVIOURALLY over a corpus (filter × title), not by diffing source:
// the contract is "the same decision on the same input", and the root module is
// free to change how it computes that decision.

import { pass, fail, warn, ROOT } from './helpers.mjs';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import {
  buildTitleFilter as coreFilter,
  WORD_PREFIX as CORE_WORD_PREFIX,
  AND_SEPARATOR as CORE_AND_SEPARATOR,
  compileKeyword as coreCompileKeyword,
  compilePositiveKeyword as coreCompilePositiveKeyword,
} from '../title-keywords.mjs';

console.log('\ntitle-keywords — web mirror vs root module');

const WEB_MIRROR = join(ROOT, 'web', 'src', 'lib', 'core', 'title-keywords.mjs');
if (!existsSync(join(ROOT, 'web', 'src'))) {
  warn('web/ not present in this checkout — skipping the title-keywords parity check');
} else if (!existsSync(WEB_MIRROR)) {
  fail('web/ exists but web/src/lib/core/title-keywords.mjs is missing — the parity check cannot verify (moved?)');
} else {
  const web = await import(pathToFileURL(WEB_MIRROR).href);

  // ── Exports are part of the contract, not incidental ────────────────────────
  // A caller that must split AND-groups itself (the dead-positive guard in
  // tests/title-filter-word-prefix.test.mjs) needs the same separator on both
  // sides, or "the same rule" holds only where nobody looks.
  const EXPORTS = ['WORD_PREFIX', 'AND_SEPARATOR', 'compileKeyword', 'compilePositiveKeyword', 'buildTitleFilter'];
  const missing = EXPORTS.filter((k) => web[k] === undefined);
  if (missing.length === 0) pass(`web mirror exports all ${EXPORTS.length} public names`);
  else fail(`web mirror is missing exports: ${missing.join(', ')}`);

  if (web.WORD_PREFIX === CORE_WORD_PREFIX) pass(`WORD_PREFIX identical (${JSON.stringify(CORE_WORD_PREFIX)})`);
  else fail(`WORD_PREFIX drift: web=${JSON.stringify(web.WORD_PREFIX)} core=${JSON.stringify(CORE_WORD_PREFIX)}`);

  const sameRe = (a, b) => a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  if (sameRe(web.AND_SEPARATOR, CORE_AND_SEPARATOR)) pass(`AND_SEPARATOR identical (/${CORE_AND_SEPARATOR.source}/${CORE_AND_SEPARATOR.flags})`);
  else fail(`AND_SEPARATOR drift: web=${web.AND_SEPARATOR} core=${CORE_AND_SEPARATOR}`);

  // ── Corpus: titles ─────────────────────────────────────────────────────────
  // The first block is REAL data from this repo's own data/pipeline.md. The
  // drift that actually happened is "the Explorer keeps a job the scanner would
  // have dropped", so the samples that caused that must be in the corpus rather
  // than synthetic lookalikes: 软件实施工程师 passes the domain-word positive,
  // 信息技术专员 gets in on 「技术」, 叉车司机/行政专员 are pure noise, and the
  // 猎聘 cards carry city/salary/experience glued onto the title.
  const TITLES = [
    '软件实施工程师',
    '信息技术专员【西安】10-15k经验不限本科',
    'it软件测试',
    '叉车司机【安庆-迎江区】7-8k1-3年学历不限',
    '食品化验员【宁波-镇海区】5-6k1-3年大专',
    '兼职居家ERP 开发项目经理（远程｜时间灵活',
    '项目经理兼职',
    '27届实习转校招-人力资源软件项目实习生',
    'IT项目管理 【 郑州-高新区 】 5-8k 3年以上 统招本科',
    'Java高级开发(J14929) 【 郑州-中原区 】 10-20k·13薪 3-5年 本科',
    '（高薪）软件/项目销售',
    '新能源光伏项目经理',
    '技术员',
    '行政后勤/总务【上海-浦东新区】9-12k经验不限大专',
    // The shapes each keyword rule exists for.
    'COO',
    'Coordinator',
    'Operations Intern',
    'Internal Tools Engineer',
    'International Partnerships Manager',
    'Director - Software Engineering',
    'Senior Director, Platform Engineering',
    '.NET Developer',
    'C++ Engineer',
    'VP of Engineering',
    'VPoE',
    'L&D Manager',
    'Développeur Logiciel',
    'préintern',
    '',
  ];

  // ── Corpus: filters ────────────────────────────────────────────────────────
  // Every entry is a documented config form or a rule the root module calls out
  // by name, not a synthetic edge case.
  const FILTERS = [
    ['positive-only substring', { positive: ['engineer'] }],
    ['negative-only (empty positive = accept everything)', { negative: ['intern'] }],
    ['positive + negative', { positive: ['engineer', 'developer'], negative: ['word:intern', 'sales'] }],
    ['2-3 letter acronym is word-anchored', { positive: ['vp', 'coo'] }],
    ['word: prefix at any length', { negative: ['word:intern'] }],
    ['word: prefix beats a substring hit (Intern vs Internal)', { positive: ['engineer'], negative: ['word:intern'] }],
    ['bare word: matches nothing (config typo, not a flood)', { positive: ['word:', 'engineer'], negative: ['word:'] }],
    ['AND-group', { positive: ['director + engineering'] }],
    ['AND-group with a short term', { positive: ['vp + engineering'] }],
    ['C++ / .NET keep permissive substring matching', { positive: ['c++', '.net'] }],
    ['non-string and blank entries are dropped, not coerced', { positive: ['engineer', 42, null, '   '], negative: [true, ' sales ', {}] }],
    ['non-array field counts as absent', { positive: 'engineer', negative: 'intern' }],
    ['title_filter absent', undefined],
    ['title_filter null', null],
    ['title_filter is an array', []],
    ['negative side has no AND-groups', { negative: ['a + b'] }],
  ];

  const compare = (label, doc) => {
    let wf;
    let cf;
    try {
      wf = web.buildTitleFilter(doc);
      cf = coreFilter(doc);
    } catch (e) {
      fail(`${label}: buildTitleFilter threw — ${e.message}`);
      return 0;
    }
    let drift = 0;
    let compared = 0;
    for (const title of TITLES) {
      compared++;
      let a;
      let b;
      try {
        a = wf(title);
        b = cf(title);
      } catch (e) {
        fail(`${label} × ${JSON.stringify(title)}: predicate threw — ${e.message}`);
        drift++;
        continue;
      }
      if (a !== b) {
        drift++;
        if (drift <= 3) fail(`drift on ${label} × ${JSON.stringify(title)}: web=${a} core=${b}`);
      }
    }
    if (drift === 0) pass(`parity: ${label} (${compared} titles)`);
    else if (drift > 3) fail(`${label}: ${drift} of ${compared} titles drifted (first 3 shown)`);
    return compared;
  };

  let total = 0;
  for (const [label, doc] of FILTERS) total += compare(label, doc);
  pass(`compared ${total} (filter × title) decisions across ${FILTERS.length} filter shapes`);

  // ── The unit-level compilers, which the gate may call directly ─────────────
  const KEYWORDS = ['engineer', 'vp', 'word:intern', 'word:', 'director + engineering', 'c++', '.net', ' intern ', '', '招聘'];
  const unitDrift = KEYWORDS.filter((kw) => {
    const a = web.compileKeyword(kw);
    const b = coreCompileKeyword(kw);
    return TITLES.some((t) => a(t.toLowerCase()) !== b(t.toLowerCase()));
  });
  if (unitDrift.length === 0) pass(`compileKeyword parity over ${KEYWORDS.length} keywords × ${TITLES.length} titles`);
  else fail(`compileKeyword drift on: ${JSON.stringify(unitDrift)}`);

  const posDrift = KEYWORDS.filter((kw) => {
    const a = web.compilePositiveKeyword(kw);
    const b = coreCompilePositiveKeyword(kw);
    return TITLES.some((t) => a(t.toLowerCase()) !== b(t.toLowerCase()));
  });
  if (posDrift.length === 0) pass(`compilePositiveKeyword parity over ${KEYWORDS.length} keywords`);
  else fail(`compilePositiveKeyword drift on: ${JSON.stringify(posDrift)}`);

  // ── The configs actually on disk ───────────────────────────────────────────
  // The shipped example is the shape that exists in every checkout, so it is the
  // case that matters most; the user's own portals.yml is the file the gate
  // really reads (gitignored, so absence is a warning, never a failure).
  const fromYml = (rel) => {
    const p = join(ROOT, rel);
    if (!existsSync(p)) return null;
    const doc = yaml.load(readFileSync(p, 'utf-8'));
    return doc && typeof doc === 'object' ? doc.title_filter : null;
  };

  const exampleFilter = fromYml('templates/portals.example.yml');
  if (exampleFilter) compare('templates/portals.example.yml title_filter', exampleFilter);
  else fail('templates/portals.example.yml has no title_filter — the shipped-shape parity case is missing');

  const userFilter = fromYml('portals.yml');
  if (userFilter) compare('portals.yml title_filter (the file the gate reads)', userFilter);
  else warn('portals.yml not present (user layer) — skipped the real-config parity case');

  // ── Neither side may throw on junk: both are tolerant readers ─────────────
  for (const junk of [null, undefined, 'a string', 42, [], { positive: null }, { negative: {} }, { positive: [{}], negative: [[]] }]) {
    try {
      web.buildTitleFilter(junk)('软件实施工程师');
      coreFilter(junk)('软件实施工程师');
      pass(`both tolerate title_filter=${JSON.stringify(junk) ?? 'undefined'}`);
    } catch (e) {
      fail(`threw on title_filter=${JSON.stringify(junk) ?? 'undefined'}: ${e.message}`);
    }
  }
}
