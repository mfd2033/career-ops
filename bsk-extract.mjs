#!/usr/bin/env node
/**
 * bsk-extract.mjs — fetch a job page through the user's OWN logged-in browser
 * (browser-skill / `bsk` CLI), for boards that wall headless and logged-out
 * browsers: BOSS直聘, 猎聘, 智联招聘.
 *
 * WHY THIS EXISTS
 * Those boards serve captcha / anti-bot walls headlessly and to logged-out
 * browsers, so browser-extract.mjs (Playwright) and the browser MCP both come
 * back empty on them. The reliable path is the user's real Edge/Chrome with a
 * real login session: bsk drives it, and when a slider captcha or verify wall
 * appears, `bsk request-help` hands the page to the user for a ~5-second manual
 * solve and then we re-read the DOM.
 *
 * Usage:
 *   node bsk-extract.mjs <url> [--mode jd|listing] [--max N] [--max-chars N]
 *
 * Mirrors browser-extract.mjs's contract so callers can route between them:
 *   jd       → { url, title, text }   (whitespace-collapsed, length-capped)
 *   listing  → { url, jobs: [{title,url}] }
 * Output: compact JSON to stdout. Exit 0 on success; exit 1 on a hard error,
 * printing { "error": "...", "code": "..." } on stderr.
 *
 * Prerequisites: `bsk` CLI on PATH and a browser-skill extension connected
 * (check `bsk status`). Nothing else — no Playwright, no cloud, no API keys.
 */

import { execFile } from 'child_process';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import { rejectPrivateOrInvalid } from './liveness-browser.mjs';
import { normalizeJd, normalizeListing } from './browser-extract.mjs';
import { isZhJobDetailUrl, isZhJobHost, looksLikeCaptchaWall } from './lib/zh-jobs.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 45_000;
const CAPTCHA_HELP_TIMEOUT_MS = 3 * 60_000; // user needs a moment to solve the slider

// SPA listing pages (zhipin search, liepin search) render their rows
// asynchronously: domcontentloaded fires on an empty body, and a single
// immediate read returns zero anchors. Poll until the page has content.
// 15s ceiling — zhipin's search results frequently land 5-8s in, and an 8s
// budget intermittently cut the poll short right before the rows arrived
// (handing back the intermediate recommend page as a 1-row listing).
const DOM_READY_POLL_MS = 500;
const DOM_READY_TIMEOUT_MS = 15_000;

const READ_DOM_JS = `(() => {
  const title = (document.querySelector('h1')?.innerText || document.title || '').trim();
  // Prefer a semantic container, then a Chinese board's job-body class, then body.
  const root =
    document.querySelector('main, [role="main"], article, [class*="job-detail"], [class*="jobDetail"], [class*="job-intro"], [class*="job-intro-container"]') ||
    document.body;
  let text = '';
  if (root) {
    const c = root.cloneNode(true);
    c.querySelectorAll('script, style, nav, header, footer, noscript').forEach((el) => el.remove());
    text = c.innerText || '';
  }
  // Boards with no semantic container dump the whole page in body.innerText —
  // we keep that rather than return nothing; the nav chrome is cheap for the
  // downstream model to ignore.
  if (!text || text.trim().length < 100) {
    const body = document.body.cloneNode(true);
    body.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
    text = body.innerText || '';
  }
  const anchors = Array.from(document.querySelectorAll('a[href]'))
    .filter((el) => {
      if (el.closest('nav, header, footer')) return false;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      return el.getClientRects().length > 0;
    })
    .map((el) => ({ href: el.getAttribute('href') || '', label: (el.innerText || '').trim() }));
  // 智联招聘 (zhaopin.com/jobs) 的职位卡片是 DIV.job-card 而非 <a href>，上面的
  // a[href] 抓不到任何职位（"结果很少"的根因）。真实数据在
  // window.__INITIAL_STATE__.positionList，每项含 positionUrl/name/workCity。
  // 合成 anchor（附 city）追加，让 zhListingAnchors 按 isZhJobDetailUrl 统一过滤。
  // 绝不读 positionCount（实测 =0，不可信）；positionList 才是真数据。
  let synth = [];
  try {
    const st = window.__INITIAL_STATE__;
    if (st && Array.isArray(st.positionList)) {
      synth = st.positionList
        .filter((p) => p && p.positionUrl)
        .map((p) => ({
          href: String(p.positionUrl),
          label: String(p.name || '').trim(),
          city: String(p.workCity || '').trim(),
        }))
        .filter((a) => a.label && a.href);
    }
  } catch (e) { /* a state read must never sink the DOM read */ }
  return JSON.stringify({ title, text, anchors: anchors.concat(synth), url: location.href });
})()`;

// ── bsk plumbing ─────────────────────────────────────────────────────────

/** Run a bsk subcommand. Rejects on non-zero exit with a joined message. */
async function runBsk(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await execFileAsync('bsk', args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    // util.promisify(execFile)'s resolve shape DRIFTED across Node versions:
    // modern Node (v22+) resolves to the stdout STRING directly; older Node
    // resolves {stdout, stderr} (or a [stdout, stderr] array). The former got
    // silently lost — `const { stdout, stderr } = await …` destructured a
    // string into two undefineds, and every command looked "empty" (a bsk
    // session start reported "could not parse a session id from: (empty
    // output)"). Normalize all three shapes ONCE here.
    let stdout = '';
    let stderr = '';
    if (typeof res === 'string') {
      stdout = res;
    } else if (Array.isArray(res)) {
      stdout = res[0] ?? '';
      stderr = res[1] ?? '';
    } else if (res && typeof res === 'object') {
      stdout = res.stdout ?? '';
      stderr = res.stderr ?? '';
    }
    return { stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
  } catch (err) {
    const detail = [err.stderr, err.stdout, err.cmd ? `${err.cmd} ${err.args?.join(' ') ?? ''}` : '']
      .filter(Boolean)
      .map((s) => String(s).trim())
      .join(' | ')
      .slice(0, 500);
    const code = err.code === 'ENOENT' ? 'bsk_missing' : 'bsk_command_failed';
    const msg =
      err.code === 'ENOENT'
        ? 'bsk CLI not found on PATH (install browser-skill, or check `bsk status`)'
        : `bsk ${args.join(' ')} failed: ${detail || err.message}`;
    const e = new Error(msg);
    e.code = code;
    throw e;
  }
}

/** Parse the 4-letter session token out of `bsk session start` output. */
export function parseSessionId(output) {
  if (!output) return '';
  try {
    const j = JSON.parse(output);
    const id = j?.session_id ?? j?.sessionId ?? j?.id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  } catch {
    // not JSON — fall through to the bare-token form
  }
  const m = String(output).match(/\b([A-Za-z]{4})\b/);
  return m ? m[1] : '';
}

// ── extraction ───────────────────────────────────────────────────────────

/**
 * Fetch one job page through the user's logged-in browser.
 * Throws Error with `code` for every failure (callers fall back or report).
 *
 * @param {{ url: string, mode?: 'jd'|'listing', max?: number, maxChars?: number,
 *          allowNonZh?: boolean }} opts
 */
export async function extractWithBsk({ url, mode = 'jd', max = 200, maxChars = 12000, allowNonZh = false }) {
  const guard = rejectPrivateOrInvalid(url);
  if (guard) {
    const e = new Error(guard.reason);
    e.code = guard.code;
    throw e;
  }
  if (!allowNonZh && !isZhJobHost(url)) {
    const e = new Error(`bsk extractor is wired for the Chinese boards (zhipin/liepin/zhaopin); got ${hostOf(url)}`);
    e.code = 'not_zh_job';
    throw e;
  }

  let sessionId = '';
  try {
    const started = await runBsk(['session', 'start', '--json'], 15_000);
    sessionId = parseSessionId(started.stdout);
    if (!sessionId) {
      const e = new Error(`could not parse a session id from: ${started.stdout || '(empty output)'}`);
      e.code = 'session_failed';
      throw e;
    }

    await runBsk(['navigate', url, '--session', sessionId, '--wait-until', 'domcontentloaded'], NAVIGATE_TIMEOUT_MS);

    const raw = await readDomReadyViaBsk(sessionId, mode);

    // A captcha/login wall surfaced instead of the job body: hand the page to
    // the user for a manual solve, then re-read. At most one help round.
    if (mode === 'jd' && looksLikeCaptchaWall(raw)) {
      await runBsk(
        [
          'request-help',
          '--session', sessionId,
          '--title', '需要人工过验证',
          '--prompt', '站点弹出了验证码或登录墙。请完成验证（如滑动滑块/点击验证按钮），完成后点击页面上的 Done。我会自动继续抓取职位内容。',
          '--timeout', `${Math.round(CAPTCHA_HELP_TIMEOUT_MS / 1000)}s`,
        ],
        CAPTCHA_HELP_TIMEOUT_MS + 20_000,
      );
      const rawAfter = await readDomReadyViaBsk(sessionId, mode);
      return mode === 'listing'
        ? listingWithCities(rawAfter, rawAfter.url || url, max)
        : normalizeJd(rawAfter, rawAfter.url || url, maxChars);
    }

    return mode === 'listing'
      ? listingWithCities(raw, raw.url || url, max)
      : normalizeJd(raw, raw.url || url, maxChars);
  } finally {
    if (sessionId) {
      try {
        await runBsk(['session', 'stop', sessionId], 10_000);
      } catch {
        // the session auto-expires after idle; never mask the real result
      }
    }
  }
}

/** readDomViaBsk: run the DOM reader in the page via bsk evaluate. */
async function readDomViaBsk(sessionId) {
  const { stdout } = await runBsk(['evaluate', READ_DOM_JS, '--session', sessionId], 20_000);
  try {
    return JSON.parse(stdout);
  } catch {
    const e = new Error(`bsk evaluate returned non-JSON: ${String(stdout).slice(0, 200)}`);
    e.code = 'extract_failed';
    throw e;
  }
}

/**
 * SPA boards (zhipin search, liepin search) render their rows asynchronously:
 * domcontentloaded can fire on a near-empty body, and the rows appear a moment
 * later. A single immediate read yields the static nav chrome only — enough to
 * count as "content" but not enough for a listing. Poll until the JOB anchor
 * count stabilizes across two consecutive reads.
 *
 * TWO corrections over the naive "any anchors" rule:
 *   • The stability signal is the count of anchors that PASS the zh job-detail
 *     filter, never the raw anchor count — a board's nav chrome (猎聘: 首页 /
 *     职位 / 校园 / 海归 / 简历优化; BOSS: APP / 消息) is present from the very
 *     first read, so "stable raw anchors" fires before the dynamic rows land
 *     and returns an empty listing. (It also fires on an intermediate
 *     recommend/home page that holds 0-1 job-looking links — BUSINESS直聘's
 *     search results replace that page a moment later.)
 *   • A genuinely empty result page stays at 0 job anchors the whole window;
 *     it costs the full budget and returns the last read (0 jobs), which is
 *     the right trade against shipping a prematurely-empty hunt.
 * @param {string} sessionId
 * @param {'jd'|'listing'} mode
 * @returns {Promise<object>}
 */
async function readDomReadyViaBsk(sessionId, mode) {
  const deadline = Date.now() + DOM_READY_TIMEOUT_MS;
  let raw = null;
  let prev = -1;
  while (Date.now() <= deadline) {
    const next = await readDomViaBsk(sessionId);
    raw = next;
    if (mode === 'listing') {
      const url = typeof next?.url === 'string' ? next.url : '';
      const jobAnchors = zhListingAnchors(next?.anchors ?? [], url).length;
      // Stable AND non-zero ⇒ the dynamic row set has landed.
      if (jobAnchors > 0 && jobAnchors === prev) break;
      prev = jobAnchors;
    } else if (String(next?.text ?? '').trim().length > 0) {
      break; // a jd has text; done on first non-empty read
    }
    await new Promise((r) => setTimeout(r, DOM_READY_POLL_MS));
  }
  return raw;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable)';
  }
}

/**
 * Keep only anchors that resolve to a zh job-detail page. Listing pages carry
 * plenty of plausible-looking nav/footer/company links (APP, 消息, 马富荻,
 * company pages); without this filter they'd dominate the listing output.
 * Pure — exported for tests. Relative hrefs resolve against `baseUrl`.
 * @param {Array<{ href?: string, label?: string }>} anchors
 * @param {string} baseUrl
 * @returns {Array<{ href: string, label?: string }>}
 */
export function zhListingAnchors(anchors, baseUrl) {
  return (Array.isArray(anchors) ? anchors : []).filter((a) => {
    try {
      const href = new URL(String(a?.href ?? ''), baseUrl).href;
      return isZhJobDetailUrl(href);
    } catch {
      return false;
    }
  });
}

/**
 * Shape a listing result and carry each job's explicit city (智联 positionList
 * `workCity`) onto its `{ title, url }` entry. normalizeListing is shared with
 * the Playwright path and intentionally drops unknown anchor fields, so the
 * city is re-attached here by resolved URL — bsk-extract is the only caller
 * whose anchors may carry a `city`. Jobs without a city keep none (their
 * platform relies on the search URL's own city parameter; the browser-scan
 * post-gate falls back to the title). Pure — exported for tests.
 * @param {{ anchors?: Array<{ href?: string, label?: string, city?: string }>, url?: string }} raw
 * @param {string} baseUrl
 * @param {number} [max]
 * @returns {{ url: string, jobs: Array<{ title: string, url: string, city?: string }> }}
 */
export function listingWithCities(raw, baseUrl, max = 200) {
  const base = String(raw?.url || baseUrl || '');
  const listing = normalizeListing(zhListingAnchors(raw?.anchors, base), base, max);
  const cityByHref = new Map();
  for (const a of Array.isArray(raw?.anchors) ? raw.anchors : []) {
    const c = String(a?.city ?? '').trim();
    if (!c) continue;
    try {
      cityByHref.set(new URL(String(a.href ?? ''), base).href, c);
    } catch {
      /* unparseable href — nothing to attach */
    }
  }
  if (cityByHref.size > 0) {
    for (const j of listing.jobs) {
      const c = cityByHref.get(j.url);
      if (c) j.city = c;
    }
  }
  return listing;
}

// ── CLI ──────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  node bsk-extract.mjs <url> [--mode jd|listing] [--max N] [--max-chars N]

  --mode jd|listing  jd (default) returns { url, title, text }; listing returns { url, jobs }
  --max N            listing: maximum postings to return (default 200)
  --max-chars N      jd: text cap (default 12000)
  --help, -h         Show this help

Requires the bsk CLI + browser-skill extension connected (\`bsk status\`).`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let url;
  let mode = 'jd';
  let max = 200;
  let maxChars = 12000;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--mode') mode = args[++i];
    else if (tok === '--max' && args[i + 1] !== undefined) max = Number(args[++i]);
    else if (tok === '--max-chars' && args[i + 1] !== undefined) maxChars = Number(args[++i]);
    else if (typeof tok === 'string' && !tok.startsWith('-') && url === undefined) url = tok;
  }
  if (!url) {
    console.error(JSON.stringify({ error: `usage: ${USAGE.split('\n')[1].trim()}`, code: 'no_url' }));
    process.exit(1);
  }
  if (mode !== 'jd' && mode !== 'listing') {
    console.error(JSON.stringify({ error: `unknown mode "${mode}" (expected jd|listing)`, code: 'bad_mode' }));
    process.exit(1);
  }

  extractWithBsk({ url, mode, max, maxChars })
    .then((result) => {
      process.stdout.write(JSON.stringify(result));
    })
    .catch((err) => {
      console.error(JSON.stringify({ error: err.message, code: err.code || 'bsk_extract_error' }));
      process.exitCode = 1;
    });
}

// Only run main() when invoked directly, not when imported by tests/callers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}