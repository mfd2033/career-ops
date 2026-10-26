// 回归复现：在 explore 结果区「移除所选」的岗位，今日页（/）的「本周新匹配」仍会显示。
//
// 根因（待修）：移除记录只存在浏览器的 localStorage（career-ops:explore-removed），
// 而首页的「本周新匹配」是客户端 fetch /api/whats-new 后直接渲染，从未读这份记录。
// 服务端读的是 data/scan-history.tsv，压根不知道浏览器里移除了什么。
//
// 断言：快照 3 条（服务端 count=5），其中 2 条已被移除 →
//   卡片只剩 1 条，hero 计数 5 应显示为 3（5 减掉返回列表里被移除的 2 条）。
//
// 运行：node web/tests/debug/home-honors-explore-removed.mjs   (PORT=3000)
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 3000);
const BASE = `http://localhost:${PORT}`;
const REMOVED_KEY = "career-ops:explore-removed";

const offers = [1, 2, 3].map((i) => ({
  url: `https://example.com/job/${i}`,
  title: `Test Role ${i}`,
  company: `TestCo ${i}`,
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
// 固定供应回路的数据，不依赖真实 scan-history：返回 3 条，count 声称 5。
await page.route("**/api/whats-new**", (route) => route.fulfill({ json: { offers, count: 5 } }));
await page.route("**/api/followups**", (route) => route.fulfill({ json: { entries: [], metadata: { overdue: 0 } } }));

const countCards = () => page.getByRole("heading", { name: /Test Role/ }).count();
let failed = false;

try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Test Role/ }).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);

  const cards = await countCards();
  const hero = (await page.locator("h1").first().innerText()).replace(/\s+/g, " ");

  console.log(`[repro] 可见卡片=${cards} hero="${hero}"`);
  const heroOk = hero.includes("3 个本周新匹配");
  if (cards !== 1 || !heroOk) {
    failed = true;
    console.log("[repro] FAIL: 期望只剩 1 张卡片、hero 显示「3 个本周新匹配」");
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
