#!/usr/bin/env node
/**
 * zh-login-check.mjs — 独立登录态探测 CLI（ADR-0001 D4 的结构化返回）
 *
 * 打开指定平台的求职 profile 窗口，用 multi-signal 组合判定当前登录态
 * （会话 cookie + 用户区 + 登录按钮 + 职位数据兜底），输出结构化结论，不改任何
 * 页面、不写 tracker。供 05 登录补登、06 平台接入与人工冒烟复用。
 *
 * Output: { platform, verdict, signals, url, channel }（exit 0）。
 * 硬错误（浏览器不可用等）exit 1 + stderr { error, code }。
 *
 * Usage:
 *   node zh-login-check.mjs <zhipin|liepin|zhaopin> [--profile DIR] [--url URL]
 */

import { pathToFileURL } from 'node:url';
import { zhListingAnchors } from './bsk-extract.mjs';
import {
  collectLoginSignals,
  judgeLogin,
  launchProfileContext,
  DEFAULT_PROFILE_DIR,
  LOGIN_URLS,
} from './lib/login-check.mjs';

const SPA_ROWS_TIMEOUT_MS = 12_000;

/** 读一次职位 anchor（jobData 信号：拿到职位数据与否）。 */
async function readJobAnchors(page) {
  try {
    const raw = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'))
        .filter((el) => {
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
        })
        .map((el) => ({ href: el.getAttribute('href') || '', label: (el.innerText || '').trim() }));
      return { anchors, url: location.href };
    });
    return zhListingAnchors(raw?.anchors ?? [], raw?.url || page.url());
  } catch {
    return [];
  }
}

async function checkLogin({ platform, profileDir, url }) {
  const target = url || LOGIN_URLS[platform];
  const { context, page, channel } = await launchProfileContext(profileDir, { url: target });
  try {
    // SPA 预热：轮询直到有职位 anchor 或预算耗尽（jobData 信号）。
    const deadline = Date.now() + SPA_ROWS_TIMEOUT_MS;
    let anchors = [];
    while (Date.now() < deadline) {
      anchors = await readJobAnchors(page);
      if (anchors.length > 0) break;
      await page.waitForTimeout(500);
    }
    const signals = { ...(await collectLoginSignals(page, platform)), jobData: anchors.length > 0 };
    return {
      platform,
      verdict: judgeLogin(platform, signals),
      signals: { ...signals, jobData: anchors.length > 0 },
      url: page.url(),
      channel,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

const USAGE = `Usage:
  node zh-login-check.mjs <zhipin|liepin|zhaopin> [--profile DIR] [--url URL]

  --profile DIR  独立求职 profile 目录（默认 .cache/job-profile）
  --url URL      探测页面（默认平台入口 LOGIN_URLS）
  --help, -h     帮助`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  let platform = '';
  let profileDir = DEFAULT_PROFILE_DIR;
  let url = '';
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i];
    const next = () => args[++i];
    if (tok === '--profile') profileDir = next();
    else if (tok === '--url') url = next();
    else if (typeof tok === 'string' && !tok.startsWith('-') && !platform) platform = tok.toLowerCase();
  }
  if (!['zhipin', 'liepin', 'zhaopin'].includes(platform)) {
    console.error(JSON.stringify({ error: `usage: ${USAGE.split('\n')[1].trim()}`, code: 'bad_args' }));
    process.exit(1);
  }
  checkLogin({ platform, profileDir, url })
    .then((out) => process.stdout.write(JSON.stringify(out)))
    .catch((err) => {
      console.error(JSON.stringify({ error: String(err?.message ?? err), code: String(err?.code ?? 'login_check_failed') }));
      process.exitCode = 1;
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
