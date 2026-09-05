#!/usr/bin/env node
/**
 * zh-collect.mjs — 浏览器全量采集器（ADR-0001 D1/D2/D5）
 *
 * 用 Playwright 驱动系统 Edge（channel:'msedge'）+ 独立「求职 profile」目录，
 * 打开 BOSS直聘/猎聘/智联招聘 搜索页，按平台策略收全量职位链接：
 *   - BOSS直聘 / 智联招聘：懒加载型，`page.mouse.wheel()`（CDP 原生 trusted
 *     滚轮，浏览器认可的真实输入）连续滚到底触发加载 —— 替代 bsk 只能 JS 设
 *     scrollTop 而拿不到全量（实测 17 vs 127）的缺陷。
 *   - 猎聘：分页型，识别分页控件逐页翻页；必须登录态（未登录返回空页）。
 *
 * 采集前自动跑 multi-signal 登录预检（lib/login-check.mjs）；未登录时按
 * `--login-wait` 决定：等待扫码登录（自动弹窗 → 轮询已登录 → 自动关窗续采，
 * G8/A）或直接以未登录态采集（BOSS/智联可采；猎聘直接 login_required 失败）。
 *
 * 输出契约 = BskListing：{ url, jobs: [{ title, url, city? }] }（职位链接去重、
 * 跟踪参数归一化）。退出码 0 = 成功；1 = 失败，stderr 输出 { error, code }。
 *
 * Usage:
 *   node zh-collect.mjs <url> --platform <zhipin|liepin|zhaopin>
 *       [--profile DIR] [--max N] [--login-wait|--no-login-wait]
 *       [--login-timeout S] [--wheel-timeout S] [--timeout MS]
 */

import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rejectPrivateOrInvalid } from './liveness-browser.mjs';
import { zhListingAnchors, extractCityFromText } from './bsk-extract.mjs';
import { CITY_NAMES } from './web/src/lib/browser-search.mjs';
import { isZhJobHost } from './lib/zh-jobs.mjs';
import {
  collectLoginSignals,
  judgeLogin,
  launchProfileContext,
  DEFAULT_PROFILE_DIR,
  PLATFORM_LABEL,
  LOGIN_BUTTON_TEXTS,
} from './lib/login-check.mjs';

const NAVIGATE_TIMEOUT_MS = 45_000;   // 首次导航
const DEFAULT_WHEEL_TIMEOUT_MS = 40_000; // 滚动到底预算
const DEFAULT_LOGIN_TIMEOUT_MS = 120_000; // 等待扫码登录预算
const DEFAULT_MAX = 200;
const SPA_ROWS_TIMEOUT_MS = 15_000;   // SPA 首屏行渲染轮询预算
const COLLECT_RETRIES = 3;            // 风控踢出后的最大重导航次数（BOSS 实测 ~1/3 放行）
const KICK_RETRY_BREATHE_MS = 1_500;  // 重试前的喘息（等 anti-bot 判定窗口过去）

// 归一化时剥掉的职位链接跟踪参数（同职位不同列表位会带不同 ka/pos，去重需先剥）。
const TRACKING_PARAMS = [
  'ka', 'from', 'pos', 'page', 'lid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
];

/** 职位 URL 归一化：去跟踪参数 + 去 hash（纯函数，供去重与单测）。 */
export function normalizeJobUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const k of TRACKING_PARAMS) u.searchParams.delete(k);
    u.hash = '';
    return u.href;
  } catch {
    return String(rawUrl ?? '');
  }
}

/**
 * 导航/占位锚点 label 黑名单：绝不当作职位输出。BOSS 的「查看更多信息」链接
 * 指向 job_detail 且带 securityId，能通过 isZhJobDetailUrl 过滤，但 label 是
 * 导航文案而非职位标题——URL 过滤挡不住它，只能按 label 拦。
 */
const NAV_LABEL_BLOCK = new Set(['查看更多信息', '查看全部', '查看更多', '更多职位', '查看详情']);

/**
 * 被风控踢出的判定：BOSS/智联的 anti-bot 二次判定会把已渲染的搜索页清空为
 * about:blank，或重定向到登录/用户页（web/user）。这些 URL 都不是搜索结果页
 * ——按 host + 已知非结果路径识别。纯函数，供 shouldRetryCollect 与单测。
 * @param {string} url 采集结束时的页面 URL
 */
export function isKickedUrl(url) {
  const u = String(url ?? '');
  if (!u || u === 'about:blank') return true;
  try {
    const p = new URL(u);
    if (p.hostname !== 'www.zhipin.com' && p.hostname !== 'www.zhaopin.com' && p.hostname !== 'www.liepin.com') return true;
    if (p.pathname.startsWith('/web/user') || p.pathname.startsWith('/web/passport')) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * 纯判定：本次采集是否值得重新导航一次（风控踢出是随机判定，重载重新走
 * 安全挑战，实测约 1/3 概率直接放行）。判据只看最终 URL：被踢（about:blank /
 * 登录墙 / 用户墙 / 非结果域）→ 该次未完整采集，无论采到多少都重试——BOSS
 * 未登录被顶到 web/user 的推荐职位绝非完整搜索结果；URL 正常（含猎聘真空
 * 结果）→ 判定成功，不重试。collect 主循环会累积各 attempt 的最优结果，
 * 重试永不丢失已采到的职位。猎聘的 login_required/login_timeout 是错误退出
 * （上层抛错），不经过这里。导出供单测锁死。
 * @param {{ url: string, attempt: number, maxAttempts: number }} p
 */
export function shouldRetryCollect({ url, attempt, maxAttempts }) {
  if (attempt >= (maxAttempts ?? COLLECT_RETRIES) - 1) return false;
  return isKickedUrl(url);
}

/**
 * 尝试点开平台首页的登录浮层，让弹出的窗口有可直接扫的二维码。
 * BOSS 等平台的扫码二维码并非自动渲染在首页，而是藏在「登录」按钮触发的
 * 弹层（dailog/log-qrcode）里。用文本匹配点开它；找不到可见「登录」按钮时
 * 静默返回（不抛致命错误，等待流程交给 pollUntilLoggedIn 轮询判定）。
 * @param {import('playwright-core').Page} page
 * @param {string} platform
 * @param {number} waitMs 点开后等待弹层渲染的预算
 */
async function openLoginDialog(page, platform, waitMs) {
  if (platform !== 'zhipin') return; // 目前只有 BOSS 确认需手动点开扫码浮层
  const clicked = await page.evaluate((labels) => {
    const visible = (el) => {
      try {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
      } catch {
        return false;
      }
    };
    const els = document.querySelectorAll('a, button, [role="button"], [class*="login"]');
    for (const el of els) {
      if (!visible(el)) continue;
      const label = (el.innerText || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      const title = (el.getAttribute('title') || '').trim();
      if (labels.includes(label) || labels.includes(aria) || labels.includes(title)) {
        el.click();
        return true;
      }
    }
    return false;
  }, LOGIN_BUTTON_TEXTS);
  if (clicked && waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  return clicked;
}

/**
 * 从（已按 isZhJobDetailUrl 过滤的）anchor 列表构造 BskListing jobs：
 * 解析相对链接 → 归一化去重 → 携带 city（可选）→ 按 max 封顶。纯函数。
 * @param {Array<{ href?: string, label?: string, city?: string }>} anchors
 * @param {string} baseUrl
 * @param {number} [max]
 */
export function dedupeJobs(anchors, baseUrl, max = DEFAULT_MAX) {
  const seen = new Set();
  const jobs = [];
  for (const a of Array.isArray(anchors) ? anchors : []) {
    const title = String(a?.label ?? '').replace(/\s+/g, ' ').trim();
    if (title.length < 3) continue;
    if (NAV_LABEL_BLOCK.has(title)) continue;
    let url;
    try {
      url = new URL(String(a?.href ?? ''), baseUrl).href;
    } catch {
      continue;
    }
    const key = normalizeJobUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const job = { title, url };
    const city = String(a?.city ?? '').trim();
    if (city) job.city = city;
    jobs.push(job);
    if (jobs.length >= max) break;
  }
  return jobs;
}

/**
 * 注入页面的 listing DOM 读取脚本：可见职位 anchor（a[href]，含 label/city），
 * 并补智联 `window.__INITIAL_STATE__.positionList` 的合成 anchor（智联职位卡片
 * 是 DIV 不是 <a>，真实数据在 positionList）。与 bsk-extract.mjs 的 READ_DOM_JS
 * 同源思路（city 走卡片父链 extractCityFromText）。
 */
const READ_LISTING_JS = `(() => {
  const CITY_NAMES = ${JSON.stringify(CITY_NAMES)};
  ${extractCityFromText.toString()}
  const anchors = Array.from(document.querySelectorAll('a[href]'))
    .filter((el) => {
      if (el.closest('nav, header, footer')) return false;
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      return el.getClientRects().length > 0;
    })
    .map((el) => ({ href: el.getAttribute('href') || '', label: (el.innerText || '').trim(), el }));
  for (const a of anchors) {
    if (!a.label) continue;
    let el = a.el;
    let city = '';
    let depth = 0;
    while (el && el !== document.body && depth < 4) {
      city = extractCityFromText(el.innerText || '', CITY_NAMES);
      if (city) break;
      el = el.parentElement;
      depth += 1;
    }
    a.city = city;
    delete a.el;
  }
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
  } catch (e) { /* 读状态失败不能拖垮整页读取 */ }
  return JSON.stringify({ anchors: anchors.concat(synth), url: location.href });
})()`;

/** 读一次页面 listing DOM（含 SPA 行），失败返回空锚点集（不抛）。 */
async function readListingDom(page) {
  try {
    const s = await page.evaluate(READ_LISTING_JS);
    const raw = JSON.parse(String(s));
    return { ...raw, url: String(raw?.url || page.url()) };
  } catch {
    return { anchors: [], url: page.url() };
  }
}

/** SPA 首屏行预热：轮询直到出现职位 anchor 或预算耗尽，返回最后一次读取。 */
async function waitForRows(page, { timeoutMs = SPA_ROWS_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastRaw = null;
  while (Date.now() < deadline) {
    const raw = await readListingDom(page);
    lastRaw = raw;
    if (zhListingAnchors(raw?.anchors ?? [], raw?.url ?? '').length > 0) return raw;
    await new Promise((r) => setTimeout(r, 500));
  }
  return lastRaw;
}

/**
 * 懒加载型平台（BOSS/智联）：CDP trusted 滚轮连续滚到底触发加载。
 * 累计所有读到的新 anchor（归一化去重），连续 minStableRounds 次读取不再新增
 * 即认为到底。返回 { url, jobs }。
 */
async function wheelCollect(page, { max = DEFAULT_MAX, timeoutMs = DEFAULT_WHEEL_TIMEOUT_MS, minStableRounds = 2 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const collected = new Map(); // normalizedKey → { href, label, city }
  let prev = -1;
  let stable = 0;
  let finalUrl = '';
  try {
    await page.mouse.move(720, 420); // 鼠标停在列表区，滚轮事件落点正确
  } catch {
    /* 无鼠标上下文也不致命 */
  }
  while (Date.now() < deadline) {
    const raw = await readListingDom(page);
    finalUrl = raw?.url || page.url();
    const anchors = zhListingAnchors(raw?.anchors ?? [], finalUrl);
    for (const a of anchors) {
      const key = normalizeJobUrl(new URL(a.href, finalUrl).href);
      if (!collected.has(key)) collected.set(key, { href: a.href, label: a.label, city: a.city });
    }
    const count = collected.size;
    if (count > 0 && count === prev) stable += 1;
    else stable = 0;
    prev = count;
    if (stable >= minStableRounds) break;
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(300);
  }
  return { url: finalUrl, jobs: dedupeJobs([...collected.values()], finalUrl, max) };
}

/** 找猎聘分页「下一页」控件（可见、未禁用）。找不到返回 null。 */
async function findNextPage(page) {
  const SELECTORS = [
    'a.pager-next:not([class*="disabled"]):not([aria-disabled="true"])',
    'li.pager-next:not([class*="disabled"]) a',
    '.pager a.next:not([class*="disabled"]):not([aria-disabled="true"])',
    'li.next a:not([class*="disabled"]):not([aria-disabled="true"])',
    'a[class*="pager-next"]:not([class*="disabled"]):not([aria-disabled="true"])',
    'button[class*="next"]:not([disabled])',
  ];
  for (const sel of SELECTORS) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 分页型平台（猎聘）：逐页翻页采集全量。连续 2 页无新增或找不到下一页即停。
 * 返回 { url, jobs }（跨页按归一化 URL 去重）。
 */
async function paginateCollect(page, { max = DEFAULT_MAX, maxPages = 25, timeoutMs = 90_000 } = {}) {
  const collected = new Map(); // normalizedKey → { href, label, city }
  let emptyRounds = 0;
  const deadline = Date.now() + timeoutMs;
  for (let p = 0; p < maxPages && Date.now() < deadline; p += 1) {
    const raw = await readListingDom(page);
    const finalUrl = raw?.url || page.url();
    const anchors = zhListingAnchors(raw?.anchors ?? [], finalUrl);
    const before = collected.size;
    for (const a of anchors) {
      const key = normalizeJobUrl(new URL(a.href, finalUrl).href);
      if (!collected.has(key)) collected.set(key, { href: a.href, label: a.label, city: a.city });
    }
    emptyRounds = collected.size > before ? 0 : emptyRounds + 1;
    if (emptyRounds >= 2) break; // 两页都没新职位 → 到底
    const next = await findNextPage(page);
    if (!next) break;
    try {
      await next.click();
    } catch {
      break; // 元素失效（页面已跳转/重渲染）
    }
    await page.waitForTimeout(900);
  }
  const finalUrl = page.url();
  return { url: finalUrl, jobs: dedupeJobs([...collected.values()], finalUrl, max) };
}

/** 轮询直到登录态恢复（05：用户扫码后自动续扫）。 */
async function pollUntilLoggedIn(page, platform, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const signals = await collectLoginSignals(page, platform);
    if (judgeLogin(platform, signals) === 'logged-in') return true;
    await page.waitForTimeout(1_500);
  }
  return false;
}

/** 结构化的 stderr 提示（browser-scan.ts 原样转发为 log 事件）。 */
function notice(msg) {
  process.stderr.write(`${JSON.stringify({ log: msg })}\n`);
}

/** 当前活跃浏览器上下文（SIGTERM 时尽力关闭，避免残留 msedge 进程）。 */
let activeContext = null;

/** 采集主流程。被风控踢出（about:blank / 登录墙重定向）时按 shouldRetryCollect
 *  重导航，最多 COLLECT_RETRIES 次——BOSS 的 anti-bot 二次判定是随机放行的，
 *  重载重新走安全挑战即可恢复（实测 ~1/3 单次成功率，3 次 ~70%）。 */
async function collect({ url, platform, profileDir, max, loginWait, loginTimeoutMs, wheelTimeoutMs }) {
  const guard = rejectPrivateOrInvalid(url);
  if (guard) throw exitError(guard.code, guard.reason);
  if (!isZhJobHost(url)) {
    throw exitError('not_zh_job', `collector is wired for zhipin/liepin/zhaopin; got ${hostOf(url)}`);
  }

  const { context, page, channel } = await launchProfileContext(profileDir);
  activeContext = context;
  try {
    // 累积各 attempt 的最优结果：重试永不丢失已采到的职位——被踢尝试（如未登录
    // 顶到 web/user → jobs>0）是"更差或部分"结果，但不应因此吞掉一个更全的尝试。
    let best = null;
    for (let attempt = 0; attempt < COLLECT_RETRIES; attempt += 1) {
      if (attempt > 0) {
        notice(`[${PLATFORM_LABEL[platform]}] 被风控踢出，重试 ${attempt + 1}/${COLLECT_RETRIES}…`);
        await new Promise((r) => setTimeout(r, KICK_RETRY_BREATHE_MS));
      }
      // 登录等待只在首次 attempt 做：用户扫码失败过的会话，重试再等 120s 只会
      // 拖爆 browser-scan.ts 的 300s 子进程预算（06 验收"不悬挂"）。后续 attempt
      // 直接以当前会话状态采集——登录成功则自然 logged-in，未登录则快速失败重试。
      const listing = await collectOnce(page, { url, platform, max, loginWait, loginTimeoutMs, wheelTimeoutMs, allowLoginWait: attempt === 0 });
      if (!best || listing.jobs.length > best.jobs.length) best = listing;
      if (!shouldRetryCollect({ url: listing.url, attempt, maxAttempts: COLLECT_RETRIES })) break;
    }
    notice(`[${PLATFORM_LABEL[platform]}] 采集完成：${best.jobs.length} 个职位（${channel}）。`);
    return best;
  } finally {
    activeContext = null;
    await context.close().catch(() => {});
  }
}

/** 单次导航 + 预检 + 按平台策略采集（失败踢出由外层重试）。 */
async function collectOnce(page, { url, platform, max, loginWait, loginTimeoutMs, wheelTimeoutMs, allowLoginWait }) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS }).catch(() => {
    /* 被踢/超时也让 waitForRows 的兜底读一次页面，交给 isKickedUrl 判定 */
  });

  // ── 登录预检（multi-signal）：先预热首屏行，用真实职位量当 jobData ──
  const firstRaw = await waitForRows(page);
  const firstUrl = String(firstRaw?.url || page.url());
  const jobData = zhListingAnchors(firstRaw?.anchors ?? [], firstUrl).length > 0;
  // 被踢短路：预检阶段页面就被清空/重定向（about:blank / 登录墙），无职位可采。
  // 立即返回空 listing 让外层重试——不白跑 wheel 预算（被踢尝试 ~17s 而非 ~57s，
  // 3 次也在 browser-scan.ts 的 300s 预算内）。
  if (!jobData && isKickedUrl(firstUrl)) {
    return { url: firstUrl, jobs: [] };
  }
  const signals = { ...(await collectLoginSignals(page, platform)), jobData };
  const verdict = judgeLogin(platform, signals);
  notice(`[${PLATFORM_LABEL[platform]}] 登录预检：${verdict}`);

  if (verdict !== 'logged-in') {
    if (loginWait && allowLoginWait) {
      notice(`[${PLATFORM_LABEL[platform]}] 未检测到登录态。请在弹出的窗口中扫码/登录（账号或验证码），登录后自动继续扫描（${Math.round(loginTimeoutMs / 1000)}s 超时）。`);
      // 被风控顶到登录墙/用户墙（如 BOSS 未登录重定向到 /web/user/）时，页面通常
      // 已自带登录引导（右上角「登录/注册」）。不要跳 platform 首页——BOSS 首页对
      // 自动化环境会被风控清空成 about:blank，弹窗会变成空白画面，用户看不到任何
      // 扫码框。留在当前墙页面，主动点一次「登录」按钮弹出扫码浮层（若页面上
      // 存在可见的登录入口；找不到就留给 pollUntilLoggedIn 轮询判定）。
      if (isKickedUrl(page.url())) {
        try {
          const clickedLogin = await openLoginDialog(page, platform, 4000);
          notice(`[${PLATFORM_LABEL[platform]}] ${clickedLogin ? '已点击【登录】弹出扫码浮层' : '未找到可见【登录】按钮，请手动在窗口中点击登录/来扫码'}`);
        } catch {
          /* 点开登录浮层失败不致命，交给 pollUntilLoggedIn 轮询判定 */
        }
      }
      const ok = await pollUntilLoggedIn(page, platform, loginTimeoutMs);
      if (!ok) {
        if (platform === 'liepin') {
          throw exitError('login_timeout', `[${PLATFORM_LABEL[platform]}] 登录超时：猎聘需要登录态才能采集，请登录后重试。`);
        }
        notice(`[${PLATFORM_LABEL[platform]}] 登录超时，以未登录态继续采集（登录态采集更稳）。`);
      } else {
        notice(`[${PLATFORM_LABEL[platform]}] 已检测到登录，自动继续采集。`);
      }
    } else if (platform === 'liepin') {
      throw exitError('login_required', `[${PLATFORM_LABEL[platform]}] 需要登录态才能采集（加 --login-wait 可自动等待扫码登录）。`);
    } else {
      notice(`[${PLATFORM_LABEL[platform]}] 未登录态采集（登录态更稳）。`);
    }
  }

  // ── 按平台策略采集全量（猎聘分页走自身 90s 预算，不用 wheel 预算）──
  return platform === 'liepin'
    ? await paginateCollect(page, { max })
    : await wheelCollect(page, { max, timeoutMs: wheelTimeoutMs });
}

/** 构造带 code 的采集失败（走 stderr，调用方按 code 分流）。 */
function exitError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable)';
  }
}

const USAGE = `Usage:
  node zh-collect.mjs <url> --platform <zhipin|liepin|zhaopin> [options]

  --platform SRC       zhipin|liepin|zhaopin（必填）
  --profile DIR        独立求职 profile 目录（默认 .cache/job-profile）
  --max N              listing 最大职位数（默认 ${DEFAULT_MAX}）
  --login-wait         未登录时自动等待扫码登录（默认开）
  --no-login-wait      未登录直接采（BOSS/智联）或失败（猎聘）
  --login-timeout S    等待登录预算（默认 ${Math.round(DEFAULT_LOGIN_TIMEOUT_MS / 1000)}s）
  --wheel-timeout S    滚动/翻页采集预算（默认 ${Math.round(DEFAULT_WHEEL_TIMEOUT_MS / 1000)}s）
  --timeout MS         首次导航超时（默认 ${NAVIGATE_TIMEOUT_MS}ms）
  --help, -h           帮助`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let url;
  let platform = '';
  let profileDir = DEFAULT_PROFILE_DIR;
  let max = DEFAULT_MAX;
  let loginWait = true;
  let loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS;
  let wheelTimeoutMs = DEFAULT_WHEEL_TIMEOUT_MS;
  let navTimeoutMs = NAVIGATE_TIMEOUT_MS;
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i];
    const next = () => args[++i];
    if (tok === '--platform') platform = String(next() ?? '').toLowerCase();
    else if (tok === '--profile') profileDir = next();
    else if (tok === '--max') max = Number(next());
    else if (tok === '--login-wait') loginWait = true;
    else if (tok === '--no-login-wait') loginWait = false;
    else if (tok === '--login-timeout') loginTimeoutMs = Number(next()) * 1000;
    else if (tok === '--wheel-timeout') wheelTimeoutMs = Number(next()) * 1000;
    else if (tok === '--timeout') navTimeoutMs = Number(next());
    else if (typeof tok === 'string' && !tok.startsWith('-') && url === undefined) url = tok;
  }
  if (!url || !['zhipin', 'liepin', 'zhaopin'].includes(platform)) {
    console.error(JSON.stringify({ error: `usage: ${USAGE.split('\n')[1].trim()}`, code: 'bad_args' }));
    process.exit(1);
  }

  collect({ url, platform, profileDir, max, loginWait, loginTimeoutMs, wheelTimeoutMs })
    .then((listing) => {
      process.stdout.write(JSON.stringify(listing));
    })
    .catch((err) => {
      console.error(JSON.stringify({ error: String(err?.message ?? err), code: String(err?.code ?? 'collect_failed') }));
      process.exitCode = 1;
    });
}

// SIGTERM：上层超时杀进程时尽力关掉浏览器上下文，避免残留 msedge 进程。
process.on('SIGTERM', () => {
  const ctx = activeContext;
  activeContext = null;
  if (ctx) ctx.close().catch(() => {}).finally(() => process.exit(1));
  else process.exit(1);
});

// 仅直接执行时跑 main()（被测试 import 时静默导出纯函数）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
