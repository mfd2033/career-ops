// tests/bsk-extract.test.mjs
// Locks the bsk-extract bridge behavior (issue #2973):
//   S1: pickExtractor() routing (browser-extract.mjs) — explicit extractor wins,
//       'auto'/undefined falls through to zh-host detection.
//   S2: extractWithBsk() guard throws + parseSessionId() parsing (bsk-extract.mjs)
//       — guards fire before ANY subprocess launch; parseSessionId prefers the
//       JSON branch, then the standalone-4-letter regex.
//   S3: bsk-extract.mjs CLI with a stripped PATH (no bsk resolvable) — help exits
//       0, no-url/bad-mode fail fast, a valid zh URL reaches runBsk and fails
//       with bsk_missing (proving no hardcoded bsk path exists).
//   S4: browser-extract.mjs CLI rejects an invalid URL with invalid_url before
//       importing playwright/bsk.
//   S5: zhListingAnchors() (bsk-extract.mjs) — listing pages carry nav/footer/
//       company anchors with plausible labels; only job-detail URLs survive.
//       isZhJobDetailUrl (lib/zh-jobs.mjs) drives the filter.
//
// Auto-discovered by test-all.mjs: a discovered suite is a guest, not a
// co-host — it reports through the pass/fail helpers and returns, leaving
// the exit and the global summary to test-all.mjs itself.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { pass, fail, ROOT } from './helpers.mjs';
import { pickExtractor } from '../browser-extract.mjs';
import { extractWithBsk, parseSessionId, zhListingAnchors, listingWithCities } from '../bsk-extract.mjs';
import { isZhJobDetailUrl } from '../lib/zh-jobs.mjs';

const NODE = process.execPath;
const BSK_EXTRACT = join(ROOT, 'bsk-extract.mjs');
const BROWSER_EXTRACT = join(ROOT, 'browser-extract.mjs');

const ZH_PAGE = 'https://www.zhipin.com/job_detail/123.html';
const EN_PAGE = 'https://jobs.apple.com/en-us/details/1';

// ── S1: pickExtractor routing ────────────────────────────────────────────
const pickCases = [
  ['bsk', ZH_PAGE, 'bsk'],
  ['bsk', EN_PAGE, 'bsk'],
  ['playwright', ZH_PAGE, 'playwright'],
  ['playwright', EN_PAGE, 'playwright'],
  ['auto', ZH_PAGE, 'bsk'],
  ['auto', EN_PAGE, 'playwright'],
  [undefined, ZH_PAGE, 'bsk'],
  [undefined, EN_PAGE, 'playwright'],
];
for (const [extractor, url, expected] of pickCases) {
  const got = pickExtractor(extractor, url);
  if (got === expected) {
    pass(`pickExtractor(${JSON.stringify(extractor)}, ${url}) -> ${expected}`);
  } else {
    fail(`pickExtractor(${JSON.stringify(extractor)}, ${url}) -> ${got}, expected ${expected}`);
  }
}

// ── S2: extractWithBsk guard throws (no subprocess launched) ─────────────
const guardCases = [
  [{ url: 'not a url' }, 'invalid_url', 'invalid URL'],
  [{ url: 'ftp://example.com/job' }, 'unsupported_protocol', 'ftp:'],
  [{ url: 'http://127.0.0.1/jobs' }, 'blocked_host', '127.0.0.1'],
  [{ url: EN_PAGE }, 'not_zh_job', 'jobs.apple.com'],
];
for (const [opts, code, msg] of guardCases) {
  try {
    await extractWithBsk(opts);
    fail(`extractWithBsk(${JSON.stringify(opts)}) should have thrown ${code}`);
  } catch (e) {
    if (e.code === code && String(e.message).includes(msg)) {
      pass(`extractWithBsk(${JSON.stringify(opts)}) throws ${code} (${msg})`);
    } else {
      fail(`extractWithBsk(${JSON.stringify(opts)}) threw code=${e.code} msg=${e.message}, expected ${code}/${msg}`);
    }
  }
}

// ── S2b: parseSessionId ──────────────────────────────────────────────────
const sessionCases = [
  ['', ''],
  [null, ''],
  ['abcd', 'abcd'],
  ['session abcd running', 'abcd'],
  ['  pqrs  ', 'pqrs'],
  ['{"session_id":"  pqrs  "}', 'pqrs'],
  ['{"sessionId":"ABCD"}', 'ABCD'],
  ['{"id":"foot"}', 'foot'],
  ['hello', ''],
];
for (const [input, expected] of sessionCases) {
  const got = parseSessionId(input);
  if (got === expected) {
    pass(`parseSessionId(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`);
  } else {
    fail(`parseSessionId(${JSON.stringify(input)}) -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
}

// ── subprocess runner ────────────────────────────────────────────────────
// Run a script with optional env; non-zero exit is a thrown error in
// execFileSync, so always returns { code, out }.
function run(script, args, env) {
  const opts = { cwd: tmpdir(), encoding: 'utf-8', timeout: 30000 };
  if (env) opts.env = env;
  try {
    const out = execFileSync(NODE, [script, ...args], opts);
    return { code: 0, out };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    return { code: e.status ?? 1, out };
  }
}

// Strip PATH down to node.exe's own directory so a child process cannot
// resolve the real 'bsk' binary — proving runBsk resolves bsk from PATH.
const NODE_ONLY_ENV = { ...process.env, PATH: dirname(process.execPath) };

// ── S3: bsk-extract.mjs CLI (no bsk on PATH) ─────────────────────────────
const bskCliCases = [
  [['--help'], 0, 'Usage:'],
  [['-h'], 0, 'Usage:'],
  [[], 1, '"code":"no_url"'],
  [[ZH_PAGE, '--mode', 'bogus'], 1, '"code":"bad_mode"'],
  [[ZH_PAGE], 1, '"code":"bsk_missing"'],
];
for (const [args, expectedExit, needle] of bskCliCases) {
  const { code, out } = run(BSK_EXTRACT, args, NODE_ONLY_ENV);
  if (code === expectedExit && out.includes(needle)) {
    pass(`bsk-extract.mjs ${JSON.stringify(args)} -> exit ${expectedExit}, has ${needle}`);
  } else {
    fail(`bsk-extract.mjs ${JSON.stringify(args)} -> exit ${code} out=${JSON.stringify(out.slice(0, 200))}, expected exit ${expectedExit} with ${needle}`);
  }
}

// ── S4: browser-extract.mjs CLI guard (invalid URL fails fast) ───────────
{
  const { code, out } = run(BROWSER_EXTRACT, ['--extractor', 'bsk', 'not-a-url']);
  const ok = code === 1 && out.includes('"code":"invalid_url"') && out.includes('invalid URL');
  if (ok) {
    pass('browser-extract.mjs --extractor bsk not-a-url -> exit 1, invalid_url (guard fires pre-import)');
  } else {
    fail(`browser-extract.mjs --extractor bsk not-a-url -> exit ${code} out=${JSON.stringify(out.slice(0, 200))}, expected exit 1 with invalid_url`);
  }
}

// ── S5: isZhJobDetailUrl / zhListingAnchors (zh listing filtering) ────────
// Zhipin search pages return ~80 anchors: nav chrome (APP, 消息, 马富荻),
// company-page links and footer links all carry plausible labels. Only
// job-detail URLs may reach the listing output.
const detailUrlCases = [
  ['https://www.zhipin.com/job_detail/c77e0ef3bf9daf3503d42dm7FFtV.html', true],
  ['https://www.liepin.com/job/1982729989.shtml', true],
  ['https://jobs.zhaopin.com/CZ1234567890000000.htm', true],
  ['https://www.zhaopin.com/jobdetail/123456789.htm', true],
  ['https://www.zhipin.com/job/1982729989/', true],
  ['https://www.zhipin.com/gongsi/50c37b6c958360011nF929y8GVo~.html', false],
  ['https://www.zhipin.com/web/geek/recommend', false],
  ['https://www.zhipin.com/web/geek/chat?sessionId=abc', false],
  ['https://app.zhipin.com/', false],
  ['https://www.zhipin.com/accessible_job/', false],
  ['https://www.zhipin.com/', false],
  ['about:blank', false],
  [undefined, false],
  ['', false],
];
for (const [href, expected] of detailUrlCases) {
  const got = isZhJobDetailUrl(href);
  if (got === expected) {
    pass(`isZhJobDetailUrl(${JSON.stringify(href)}) -> ${expected}`);
  } else {
    fail(`isZhJobDetailUrl(${JSON.stringify(href)}) -> ${got}, expected ${expected}`);
  }
}

// zhListingAnchors drops nav/footer/company anchors; relative hrefs resolve
// against the base URL before the pattern match.
{
  const base = 'https://www.zhipin.com/web/geek/jobs?query=%E5%85%A8%E6%A0%88';
  const anchors = [
    { href: '/web/geek/recommend', label: '马富荻' },
    { href: 'https://app.zhipin.com/', label: 'APP' },
    { href: '/job_detail/c77e0ef3bf9daf3503d42dm7FFtV.html', label: '中犇科技--全栈技术经理' },
    { href: '/gongsi/50c37b6c958360011nF929y8GVo~.html', label: '中犇科技' },
    { href: '/job_detail/e8253c0bdfc0c5260nJ72Nq-E1JS.html', label: '初级全栈工程师（接受小白）' },
    { href: undefined, label: 'broken anchor' },
  ];
  const filtered = zhListingAnchors(anchors, base);
  const urls = filtered.map((a) => new URL(a.href, base).href);
  if (
    filtered.length === 2 &&
    urls.includes('https://www.zhipin.com/job_detail/c77e0ef3bf9daf3503d42dm7FFtV.html') &&
    urls.includes('https://www.zhipin.com/job_detail/e8253c0bdfc0c5260nJ72Nq-E1JS.html')
  ) {
    pass('zhListingAnchors keeps only job-detail anchors, resolves relatives against base');
  } else {
    fail(`zhListingAnchors => ${JSON.stringify(filtered)}`);
  }

  // Non-array / empty input is safe.
  const safe = zhListingAnchors(undefined, base);
  if (Array.isArray(safe) && safe.length === 0) pass('zhListingAnchors(undefined) -> []');
  else fail(`zhListingAnchors(undefined) -> ${JSON.stringify(safe)}`);
}

// ── S6: listingWithCities (zhaopin positionList → city-carrying listing) ───
// The zhaopin search page renders job cards as DIVs (no <a>), so READ_DOM_JS
// synthesizes anchors from window.__INITIAL_STATE__.positionList with a `city`
// field (workCity). listingWithCities must keep those postings AND attach the
// city onto each { title, url } entry; non-zh anchors and city-less postings
// behave exactly as before.
{
  const base = 'https://www.zhaopin.com/jobs?kw=%E9%A1%B9%E7%9B%AE%E7%BB%8F%E7%90%86&jl=%E9%83%91%E5%B7%9E';
  const raw = {
    url: base,
    anchors: [
      { href: 'http://www.zhaopin.com/jobdetail/CC634185820J40852229109.htm', label: '项目经理（郑州）', city: '郑州' },
      { href: 'http://www.zhaopin.com/jobdetail/CC634185820J40852229110.htm', label: '高级项目经理', city: '北京' },
      { href: 'https://www.zhaopin.com/', label: '首页', city: '' },
    ],
  };
  const listing = listingWithCities(raw, base, 200);
  const jobs = listing.jobs;
  const byCity = Object.fromEntries(jobs.map((j) => [j.city, j.title]));
  if (
    jobs.length === 2 &&
    byCity['郑州'] === '项目经理（郑州）' &&
    byCity['北京'] === '高级项目经理' &&
    jobs.every((j) => j.url.startsWith('http://www.zhaopin.com/jobdetail/'))
  ) {
    pass('listingWithCities keeps synthesized zhaopin postings with their city');
  } else {
    fail(`listingWithCities => ${JSON.stringify(listing)}`);
  }
}

{
  // City-less anchors (猎聘/BOSS anchor cards) keep a plain { title, url }.
  const raw = {
    url: 'https://www.liepin.com/zhaopin/?key=x&dq=150020',
    anchors: [
      { href: 'https://www.liepin.com/job/1982729989.shtml', label: '郑州 项目经理' },
      { href: 'https://www.liepin.com/job/1982729990.shtml', label: '技术经理' },
    ],
  };
  const listing = listingWithCities(raw, raw.url, 200);
  const jobs = listing.jobs;
  if (
    jobs.length === 2 &&
    jobs.every((j) => !Object.prototype.hasOwnProperty.call(j, 'city')) &&
    jobs.some((j) => j.title === '郑州 项目经理')
  ) {
    pass('listingWithCities passes city-less anchors through without a city field');
  } else {
    fail(`listingWithCities(city-less) => ${JSON.stringify(listing)}`);
  }
}