// 回归复现：今日页「查看全部 N →」的 N 与搜索页（explore?view=fresh）实际显示的结果数不一致。
//
// 根因（待修）：首页用的是服务端 count（7 天窗口的完整总数，可能远超渲染上限），而
// /api/whats-new 的 offers 最多返回 MAX_OFFER_LIMIT=200 条；explore 页头部的计数建在
// 这 200 条（去掉被移除的行）之上。于是首页说 724、搜索页只显示 13 条。
// 修法：首页与搜索页报同一个数 —— 「实际能看到的行数」，不再显示一个点不进去的总数。
//
// 断言：stub 返回 15 条、count 声称 724、其中 2 条已被移除 →
//   可见卡片 12（列表最多渲染 12 张）、hero 与「查看全部」都显示 13，且页面上不出现 724。
//
// 运行：node web/tests/debug/home-see-all-count-matches-explore.mjs   (PORT=3000)
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 3000);
const BASE = `http://localhost:${PORT}`;
const REMOVED_KEY = "career-ops:explore-removed";

const offers = Array.from({ length: 15 }, (_, i) => ({
  url: `https://example.com/job/${i + 1}`,
  title: `Test Role ${i + 1}`,
  company: `TestCo ${i + 1}`,
  ats: "greenhouse",
  postedAt: "2026-10-25",
  location: "Remote",
}));
const removed = offers.slice(0, 2).map((o) => o.url);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.addInitScript(
  ([key, urls]) => {
    try {
      localStorage.setItem("career-ops:lang", "zh");
      localStorage.setItem(key, JSON.stringify(urls));
    } catch {}
  },
  [REMOVED_KEY, removed],
);
// 固定供应回路数据，不依赖真实 scan-history：offers 只有 15 条（模拟上限截断），
// 但服务端 count 声称 724 —— 正是用户看到「查看全部 724」而搜索页只有十几条的场景。
await page.route("**/api/whats-new**", (route) => route.fulfill({ json: { offers, count: 724 } }));
await page.route("**/api/followups**", (route) => route.fulfill({ json: { entries: [], metadata: { overdue: 0 } } }));

let failed = false;

try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Test Role/ }).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);

  const cards = await page.getByRole("heading", { name: /Test Role/ }).count();
  const hero = (await page.locator("h1").first().innerText()).replace(/\s+/g, " ");
  const seeAll = page.locator('a[href="/explore?view=fresh"]');
  const seeAllText = (await seeAll.count()) > 0 ? (await seeAll.first().innerText()).replace(/\s+/g, " ") : "";

  console.log(`[repro] 可见卡片=${cards} hero="${hero}" 查看全部="${seeAllText}"`);
  const heroOk = hero.includes("13 个本周新匹配") && !hero.includes("724");
  const seeAllOk = seeAllText.includes("查看全部 13");
  if (cards !== 12 || !heroOk || !seeAllOk) {
    failed = true;
    console.log("[repro] FAIL: 期望卡片=12、hero 与「查看全部」都显示 13（而不是服务端总数 724）");
  } else {
    console.log("[repro] PASS");
  }
} catch (e) {
  failed = true;
  console.log(`[repro] ERROR: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
