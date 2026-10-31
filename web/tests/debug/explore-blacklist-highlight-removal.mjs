// 回归复现：「拉黑所选」带入的黑名单词，删掉其中任意一个，其余的高亮必须还在。
//
// 症状（用户报）：点开标题门弹窗，黑名单里有 N 个琥珀色高亮词（「拉黑所选」刚带进来
// 的）。点任意一个的 ×，其余全部褪色，顶部「已从所选岗位带入 N 个黑名单词」也跟着
// 消失——读起来像「带进来的只有一个」。
//
// 根因假设（待本脚本证实）：gate-panel 的 edit() 对任何手动编辑都 setPreaddedWords([])，
// 高亮集被整批清空，而不是只摘掉被删的那一个词。
//
// 断言：4 个带入词 → 删 1 个后仍亮 3 个，且顶部提示读数同步降到 3。
// 用固定快照，不触发真实扫描；只写浏览器 sessionStorage，不碰任何数据文件。
//
// 运行：node web/tests/debug/explore-blacklist-highlight-removal.mjs   (PORT=3000)
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 3000);
const BASE = `http://localhost:${PORT}`;
const KEY = "career-ops:explore-results";
const offers = [
  { url: "https://example.com/job/1", title: "Alpha Beta", company: "TestCo 1", ats: "greenhouse", postedAt: "2026-10-25", location: "Remote" },
  { url: "https://example.com/job/2", title: "Gamma Delta", company: "TestCo 2", ats: "greenhouse", postedAt: "2026-10-25", location: "Remote" },
];
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

// 本机只装了 Edge、ms-playwright 里也没有 chromium 包，于是借系统浏览器跑（PW_CHANNEL 可换）。
// PW_CHANNEL=chrome / PW_CHANNEL="" 可切回自带 chromium。
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL ?? "msedge" });
const page = await browser.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("career-ops:lang", "zh");
  } catch {}
});

/** 弹窗里琥珀色（= 「拉黑所选」带入）的 chip 数。 */
const amberChips = () =>
  page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-label="过滤配置"]');
    if (!dlg) return -1;
    return [...dlg.querySelectorAll("span")].filter((s) => String(s.className).includes("border-amber-500/40")).length;
  });
/** 顶部「已从所选岗位带入 N 个」的读数；横幅不在时返回 0。 */
const bannerCount = () =>
  page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-label="过滤配置"]');
    if (!dlg) return -1;
    const p = [...dlg.querySelectorAll("p")].find((el) => el.className.includes("border-amber-500/30"));
    const m = p?.textContent?.match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  });

let failed = false;

try {
  await page.goto(`${BASE}/explore`, { waitUntil: "domcontentloaded" });
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, JSON.stringify(v)), [KEY, snap]);
  await page.reload({ waitUntil: "domcontentloaded" });
  // 结果区是表格行（标题是 span，不是 heading），按文本等第一行落地。
  await page.getByText("Alpha Beta").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: /拉黑/ }).click();
  await page.locator('[aria-label="过滤配置"]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(200);

  const before = await amberChips();
  const bannerBefore = await bannerCount();

  // 删掉第一个高亮词（取它的文本，再用带词名的 aria-label 点 ×，避免选中别的 chip）。
  const firstWord = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-label="过滤配置"]');
    const chip = [...dlg.querySelectorAll("span")].find((s) => String(s.className).includes("border-amber-500/40"));
    return chip?.firstChild?.textContent?.trim() ?? "";
  });
  await page.getByRole("button", { name: `删除 ${firstWord}` }).click();
  await page.waitForTimeout(200);

  const after = await amberChips();
  const bannerAfter = await bannerCount();

  console.log(`[repro] 删「${firstWord}」前：高亮=${before} 提示=${bannerBefore}；删后：高亮=${after} 提示=${bannerAfter}`);
  if (before < 2) {
    failed = true;
    console.log("[repro] FAIL: 前置条件不成立——带入词少于 2 个，无法观察「删一个影响其余」");
  } else if (after !== before - 1 || bannerAfter !== bannerBefore - 1) {
    failed = true;
    console.log(`[repro] FAIL: 期望 高亮 ${before} -> ${before - 1}、提示 ${bannerBefore} -> ${bannerBefore - 1}`);
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
