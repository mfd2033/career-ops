// 回归复现：explore 结果区「移除所选」——移除的行必须在刷新后、以及下一次搜索的
// 新结果集里都保持隐藏，直到点「恢复已移除」。
//
// 根因（已修）：「移除所选」的集合当时只是 ResultsList 的组件内存 state，刷新即丢；
// 现在由 ExploreProvider 持有并持久化到 localStorage（与收件箱 hidden/shortlist 同款）。
//
// 断言：3 张卡片 → 移除后 0 → 刷新后 0 → 换成「新搜索」结果集（3 张旧 + 1 张新）
// 后只剩 1 张 → 点「恢复已移除」后 4 张全部回来。
// 用固定快照，不触发真实扫描；只写浏览器存储，不碰任何数据文件。
//
// 运行：node web/tests/debug/explore-remove-selection-refresh.mjs   (PORT=3000)
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 3000);
const BASE = `http://localhost:${PORT}`;
const KEY = "career-ops:explore-results";
const offers = [1, 2, 3].map((i) => ({
  url: `https://example.com/job/${i}`,
  title: `Test Role ${i}`,
  company: `TestCo ${i}`,
  ats: "greenhouse",
  postedAt: "2026-10-25",
  location: "Remote",
}));
const snap = {
  v: 1,
  mode: "scan",
  scanSource: "bsk",
  phase: "results",
  offers,
  matchCount: offers.length,
  companiesScanned: 10,
  companiesAvailable: 10,
  capHit: false,
  droppedNoDate: 0,
  sources: {},
  partial: false,
  status: "",
  error: "",
  scannerMissing: false,
  added: [],
  aiTrace: [],
  aiCost: { searches: 0, candidates: 0, fetches: 0 },
  aiIntent: "",
};
// 「下一次搜索」：同样的 3 条 + 1 条新结果，用来验证跨搜索仍然隐藏。
const nextSearchOffers = [
  ...offers,
  { url: "https://example.com/job/4", title: "Test Role 4", company: "TestCo 4", ats: "greenhouse", postedAt: "2026-10-26", location: "Remote" },
];
const nextSnap = { ...snap, offers: nextSearchOffers, matchCount: nextSearchOffers.length };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("career-ops:lang", "zh");
  } catch {}
});

const countCards = () => page.getByRole("heading", { name: /Test Role/ }).count();
let failed = false;

try {
  await page.goto(`${BASE}/explore`, { waitUntil: "domcontentloaded" });
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, JSON.stringify(v)), [KEY, snap]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Test Role/ }).first().waitFor({ timeout: 15000 });

  const before = await countCards();
  const btn = page.getByRole("button", { name: /移除所选/ });
  await btn.waitFor({ timeout: 5000 });
  await btn.click();
  await page.waitForTimeout(300);
  const afterRemove = await countCards();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const afterReload = await countCards();

  // 模拟下一次搜索落地的新结果集（快照里含被移除的 3 条 + 1 条新的）。
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, JSON.stringify(v)), [KEY, nextSnap]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const afterNextSearch = await countCards();

  const restoreBtn = page.getByRole("button", { name: /恢复已移除/ });
  await restoreBtn.waitFor({ timeout: 5000 });
  await restoreBtn.click();
  await page.waitForTimeout(300);
  const afterRestore = await countCards();

  console.log(`[repro] 移除前=${before} 移除后=${afterRemove} 刷新后=${afterReload} 新搜索后=${afterNextSearch} 恢复后=${afterRestore}`);
  if (before !== 3 || afterRemove !== 0 || afterReload !== 0 || afterNextSearch !== 1 || afterRestore !== 4) {
    failed = true;
    console.log("[repro] FAIL: 期望 3 -> 0 -> 0 -> 1 -> 4");
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
