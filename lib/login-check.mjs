/**
 * lib/login-check.mjs — multi-signal 登录态探测（ADR-0001 D4）
 *
 * 为浏览器采集的三家平台（BOSS直聘/猎聘/智联招聘）做稳健的登录态判定。
 * 核心原则：多信号组合判定，绝不依赖单一信号（头像/用户区单独看都会误判——
 * BOSS 未登录也渲染头像占位，猎聘 acw_tc 未登录也带）。
 *
 * 纯函数部分（judgeLogin + 常量）无 fs/无网络/无子进程，供 web/tests 直接
 * 单测；浏览器辅助部分（launchProfileContext / collectLoginSignals）只在
 * zh-collect.mjs / zh-login-check.mjs 运行时经动态 import('playwright') 加载，
 * 纯测试路径永远不触碰 Playwright。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** 独立「求职 profile」目录（与用户日常 Edge 默认 profile 隔离，cookie 持久）。 */
export const DEFAULT_PROFILE_DIR = join(LIB_DIR, '..', '.cache', 'job-profile');

/** 判定结论：登录 / 未登录 / 不确定。 */
export const LOGIN_VERDICT = {
  LOGGED_IN: 'logged-in',
  NOT_LOGGED_IN: 'not-logged-in',
  UNCERTAIN: 'uncertain',
};

/** 平台展示名（错误提示/日志用）。 */
export const PLATFORM_LABEL = {
  zhipin: 'BOSS直聘',
  liepin: '猎聘',
  zhaopin: '智联招聘',
};

/** 登录补登用的平台入口 URL（05：自动弹窗 → 扫码 → 自动关窗）。 */
export const LOGIN_URLS = {
  zhipin: 'https://www.zhipin.com/',
  liepin: 'https://www.liepin.com/',
  zhaopin: 'https://www.zhaopin.com/',
};

/**
 * 各平台会话 cookie 的「前缀提示」（小写匹配，命中任一即 sessionCookies=true）。
 * 这些是 best-effort 名单，按需可调——multi-signal 判定的设计前提就是单信号
 * 可以弱/可误报，只有组合才下结论：
 *   - zhipin：`$_zp_cookie_` 等 BOSS 会话链（ADR 实测命名）
 *   - liepin：`acw_tc`（阿里云 WAF 会话，登录后必带；未登录也可能带——弱信号，
 *     由 userArea/loginButton/jobData 组合纠偏）
 *   - zhaopin：`zp_`/`token_` 前缀（智联登录态）
 */
export const PLATFORM_COOKIE_HINTS = {
  zhipin: ['$_zp_cookie_', 'zp_'],
  liepin: ['acw_tc', 'gr_user_id', 'user_trace_token'],
  zhaopin: ['zp_', 'token_', 'zhaopin'],
};

/**
 * 「用户区」DOM 选择器（best-effort，作为多信号之一，不作单点结论）。
 * 命中任一可见元素即 userArea=true。
 */
export const USER_AREA_SELECTORS = {
  zhipin: ['[class*="user-info"]', '[class*="userInfo"]', '[class*="header-user"]', '[class*="avatar"]'],
  liepin: ['[class*="user-info"]', '[class*="userInfo"]', '[class*="header-user"]', '[class*="avatar"]', '[class*="user-card"]'],
  zhaopin: ['[class*="user-info"]', '[class*="userInfo"]', '[class*="header-user"]', '[class*="avatar"]', '[class*="user-login"]'],
};

/** 「登录」按钮文案（可见、精确匹配，避免「登录后查看」这类包含词误判）。 */
export const LOGIN_BUTTON_TEXTS = ['登录', '请登录', '立即登录'];

/**
 * multi-signal 登录判定（纯函数，核心可测件）。
 *
 * 输入各信号（默认 undefined=未采样）：
 *   sessionCookies  平台会话 cookie 是否命中（PLATFORM_COOKIE_HINTS 前缀）
 *   userArea        页面可见「用户区」是否渲染
 *   loginButton     页面是否仍显示「登录」按钮（强负信号）
 *   jobData         页面是否拿到职位数据（统一兜底：拿不到任何职位即视为未登录）
 *
 * 规则（顺序即优先级）：
 *   1. jobData === false → not-logged-in（统一兜底：可能是登录墙/验证墙，拿不到
 *      职位数据一律当未登录处理；jobData 未采样则跳过本规则）
 *   2. loginButton === true → not-logged-in（登录按钮还挂在页面上就是没登录）
 *   3. sessionCookies && userArea → logged-in（双正信号才确认）
 *   4. 双负（都明确 false）→ not-logged-in
 *   5. 其余 → uncertain（不猜）
 *
 * @param {string} platform zhipin|liepin|zhaopin
 * @param {{ sessionCookies?: boolean, userArea?: boolean, loginButton?: boolean, jobData?: boolean }} signals
 * @returns {'logged-in'|'not-logged-in'|'uncertain'}
 */
export function judgeLogin(platform, signals = {}) {
  const { sessionCookies, userArea, loginButton, jobData } = signals;
  if (jobData === false) return LOGIN_VERDICT.NOT_LOGGED_IN;
  if (loginButton === true) return LOGIN_VERDICT.NOT_LOGGED_IN;
  if (!Object.hasOwn(PLATFORM_COOKIE_HINTS, platform)) return LOGIN_VERDICT.UNCERTAIN;
  if (sessionCookies === true && userArea === true) return LOGIN_VERDICT.LOGGED_IN;
  if (sessionCookies === false && userArea === false) return LOGIN_VERDICT.NOT_LOGGED_IN;
  return LOGIN_VERDICT.UNCERTAIN;
}

/**
 * 启动独立求职 profile 的持久浏览器（05/06 主路径：系统 Edge channel）。
 *
 * 启动顺序：msedge channel（真实 UA + 登录 cookie 持久化于 profileDir）→ 失败则
 * 回退捆绑 Chromium（未登录态快采；用独立目录避免破坏 Edge 加密 cookie）。
 * 返回 { context, page, channel, profileDir }；调用方负责 context.close()。
 *
 * @param {string} profileDir 独立 profile 目录（cookie 持久化于此）
 * @param {{ url?: string, headless?: boolean }} [opts]
 */
export async function launchProfileContext(profileDir, { url, headless = false } = {}) {
  const { chromium } = await import('playwright');
  const base = {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled'],
  };
  const attempts = [
    { channel: 'msedge', dir: profileDir },
    { channel: null, dir: `${profileDir}-chromium` }, // Edge 不可用时回退
  ];
  let lastErr = null;
  for (const { channel, dir } of attempts) {
    try {
      const context = await chromium.launchPersistentContext(
        dir,
        channel ? { ...base, channel } : { ...base },
      );
      const page = context.pages()[0] ?? (await context.newPage());
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return { context, page, channel: channel || 'chromium', profileDir: dir };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('playwright launch failed');
}

/**
 * 采集页面上的登录信号（cookie 存在性 + 用户区 + 登录按钮）。
 * jobData 由调用方从其职位 anchor 读取中补上（zh-collect/zh-login-check 各有
 * 读页脚本）；本函数返回 jobData: undefined，让 judgeLogin 跳过兜底规则。
 * @param {import('playwright-core').Page} page
 * @param {string} platform
 * @returns {Promise<{ sessionCookies: boolean, userArea: boolean, loginButton: boolean, jobData: undefined }>}
 */
export async function collectLoginSignals(page, platform) {
  let cookies = [];
  try {
    cookies = await page.context().cookies();
  } catch {
    cookies = [];
  }
  const hints = (PLATFORM_COOKIE_HINTS[platform] ?? []).map((h) => h.toLowerCase());
  const sessionCookies = cookies.some((c) => hints.some((h) => String(c.name ?? '').toLowerCase().startsWith(h)));

  const dom = await page
    .evaluate(
      (cfg) => {
        const visible = (el) => {
          try {
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
          } catch {
            return false;
          }
        };
        const userArea = cfg.userAreaSelectors.some((sel) => {
          const els = document.querySelectorAll(sel);
          for (const el of els) if (visible(el)) return true;
          return false;
        });
        const loginButton = cfg.loginButtonTexts.some((t) => {
          const els = document.querySelectorAll('a, button, [role="button"]');
          for (const el of els) {
            if (!visible(el)) continue;
            const label = (el.innerText || '').trim();
            const aria = (el.getAttribute('aria-label') || '').trim();
            const title = (el.getAttribute('title') || '').trim();
            if (label === t || aria === t || title === t) return true;
          }
          return false;
        });
        return { userArea, loginButton };
      },
      {
        userAreaSelectors: USER_AREA_SELECTORS[platform] ?? [],
        loginButtonTexts: LOGIN_BUTTON_TEXTS,
      },
    )
    .catch(() => ({ userArea: false, loginButton: false }));

  return { sessionCookies, userArea: dom.userArea, loginButton: dom.loginButton, jobData: undefined };
}
