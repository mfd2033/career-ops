// 回归复现：探索页已有结果时刷新，页面必须先画「结果」，不能先闪一页别的。
//
// 根因（已修）：回灌 sessionStorage 快照本来是被动 effect，晚于首帧——服务端 HTML
// 就是配置表单，所以刷新先看到表单；入口是今日页「查看全部」（?view=fresh）时，
// loadFresh 又会清空列表并把 phase 打回 casting，于是先看到「正在加载新匹配…」整屏
// （0 token + 骨架卡）约 1-2s，再落到结果区。现在：
//   1) 回灌改 layout effect（绘制前落地），并且回灌完成前视图只画中性骨架（aria-busy）；
//   2) loadFresh 在已有结果时静默替换，不再清空 + 走 casting 整屏。
//
// 断言：刷新后第一个「画了东西」的帧（不含骨架、不含空文档）必须已经是结果卡。
// 覆盖：普通刷新 / ?q=…&ats=… / ?mode=browser… / ?view=fresh。
// ?view=fresh 下静默刷新会在结果区原地换成最新一批，所以只比较首帧、不看之后的帧。
// 用固定快照，不触发真实扫描；只写浏览器存储，不碰任何数据文件。
//
// 运行：node web/tests/debug/explore-refresh-no-flash.mjs   (PORT=3000)
// 无内置浏览器时可 PW_CHANNEL=msedge 用系统 Edge。
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

const CASES = [
  ["普通刷新", "/explore"],
  ["ATS 链接", "/explore?q=frontend&ats=greenhouse"],
  ["浏览器链接", "/explore?mode=browser&zh=frontend&sources=bsk"],
  ["今日页查看全部", "/explore?view=fresh"],
];

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const page = await browser.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("career-ops:lang", "zh");
  } catch {}
});
// 采样器：每次 rAF 记一条「这一帧在画什么」，刷新前后都常驻（addInitScript 会在新文档重跑）。
await page.addInitScript(() => {
  window.__frames = [];
  let n = 0;
  const grab = () => {
    const txt = document.body ? document.body.innerText || "" : "";
    window.__frames.push({
      t: Math.round(performance.now()),
      // 空文档/只有壳的帧不算「画了一页」——那是还没渲染。
      blank: txt.trim().length < 20,
      skeleton: !!document.querySelector('[aria-busy="true"]'),
      results: txt.includes("Test Role"),
    });
  };
  const loop = () => {
    grab();
    if (n++ < 500) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

let failed = false;
try {
  for (const [label, path] of CASES) {
    await page.goto(`${BASE}/explore`, { waitUntil: "domcontentloaded" });
    await page.evaluate(([k, v]) => sessionStorage.setItem(k, JSON.stringify(v)), [KEY, snap]);
    await page.evaluate((p) => history.replaceState(null, "", p), path);
    await page.evaluate(() => {
      window.__frames = [];
    });
    await page.reload({ waitUntil: "commit" });
    await page.waitForTimeout(3000);
    const frames = await page.evaluate(() => window.__frames || []);
    // 违反不变式：第一帧「真内容」不是骨架也不是结果 → 用户看到了一次「别的页面」
    // （配置表单，或 view=fresh 的「正在加载新匹配…」整屏）。
    const firstContent = frames.find((f) => !f.blank && !f.skeleton);
    const firstResult = frames.find((f) => f.results);
    const ok = frames.length > 0 && !!firstContent && firstContent.results === true;
    console.log(
      `[repro] ${label} ${ok ? "PASS" : "FAIL"} · 帧数=${frames.length} · 首个结果帧=${firstResult ? firstResult.t + "ms" : "无"}` +
        (firstContent && !firstContent.results ? ` · 首帧真内容不是结果（${firstContent.t}ms）` : ""),
    );
    if (!ok) failed = true;
  }
} catch (e) {
  failed = true;
  console.log(`[repro] ERROR: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
