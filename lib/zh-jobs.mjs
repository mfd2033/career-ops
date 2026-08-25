/**
 * lib/zh-jobs.mjs — Chinese job-board host detection and captcha-wall signals,
 * shared by bsk-extract.mjs and the browser-extract.mjs fallback routing.
 * Pure functions — no fs, no network, no child processes.
 *
 * Background: BOSS直聘 (zhipin.com / kanzhun.com), 猎聘 (liepin.com) and 智联招聘
 * (zhaopin.com) block headless AND logged-out browsers with captcha / anti-bot
 * walls, so the headless Playwright extractor and the MCP path get ~no content
 * from them (see the notes in parse-inbound.mjs and lib/search-discovery.mjs).
 * These hosts are routed to the user's own logged-in browser via the bsk CLI.
 */

// Hosts whose job pages need a real logged-in browser. Matched on the full
// hostname (and one label of subdomains, e.g. jobs.zhaopin.com).
const ZH_JOB_HOSTS = ['zhipin.com', 'kanzhun.com', 'liepin.com', 'zhaopin.com'];

/**
 * True when the URL points at one of the Chinese boards that wall headless /
 * logged-out browsers. False for anything unparseable or outside the set.
 * @param {string} url
 * @returns {boolean}
 */
export function isZhJobHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ZH_JOB_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

// Job-detail URL patterns for the boards bsk serves (and the other zh boards).
// Listing pages are full of nav/footer/company-page links with plausible labels
// (APP, 消息, 马富荻, company pages) — these patterns keep only the anchors that
// actually point at a posting detail page.
const ZH_JOB_DETAIL_URL_RE = [
  /zhipin\.com\/job_detail\//i,
  /liepin\.com\/job\/\d+/i,
  /zhaopin\.com\/(?:jobdetail|zpdetail|job)\//i,
  /jobs\.zhaopin\.com\/C[A-Za-z0-9]+\.html?/i,
  /^https?:\/\/[^/]*\/(?:job|jobs)\/\d+/i,
  /[?&]jobid=/i,
];

/**
 * True when the href looks like a zh job-detail/posting page rather than a
 * nav/footer/company-page link. Used to filter listing-mode anchor dumps.
 * @param {string|undefined} href
 * @returns {boolean}
 */
export function isZhJobDetailUrl(href) {
  return ZH_JOB_DETAIL_URL_RE.some((re) => re.test(String(href ?? '')));
}

// Verbatim short strings these boards put on their captcha / verify / login
// walls. Deliberately Chinese-first (`验证码` alone would false-positive on a
// JD that says "开发验证码系统"), so looksLikeCaptchaWall additionally requires
// the extracted page text to be near-empty — a real wall has no job body.
const CAPTCHA_SIGNALS = [
  '安全验证',
  '人机验证',
  '访问验证',
  '滑动验证',
  '拖动滑块',
  '拖动下方滑块',
  '向右滑动',
  '完成验证',
  '点击按钮进行验证',
  '请完成验证',
  'captcha',
];

/**
 * Heuristic for "this page is a captcha/login wall, not the job body":
 * a captcha phrase is present AND the visible text is near-empty (no job
 * description survived). A normal JD with a passing mention of 验证码 is long
 * enough to fail the length check and is not misclassified.
 * @param {{ title?: string, text?: string }} page
 * @returns {boolean}
 */
export function looksLikeCaptchaWall({ title = '', text = '' } = {}) {
  const haystack = `${title}\n${text}`.toLowerCase();
  const hit = CAPTCHA_SIGNALS.some((s) => haystack.includes(s.toLowerCase()));
  return hit && String(text).trim().length < 400;
}