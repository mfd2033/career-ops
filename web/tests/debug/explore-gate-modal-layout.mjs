// 行为验证：标题门配置弹窗的版式——窗口更宽，纵向滚动条在窗口内，标题与保存栏在滚动时不动。
//
// 为什么要有这个脚本：gate-panel.test.mjs 只锁源码形状（ADR-0072 known gap），而「滚动时哪
// 一块跟着走」纯属 DOM 行为。形状写着 overflow-y-auto 也可能滚错了元素（比如整页一起滚、
// 或者滚动落在弹窗自己身上把标题顶走），所以这里按真浏览器量一次矩形与滚动量。
//
// 断言（固定快照，不触发扫描，只写 sessionStorage，不碰 portals.yml）：
//   1. 弹窗比旧的 max-w-lg（512px）更宽；
//   2. 滚动发生在弹窗内部的一个子元素上，弹窗本身不滚、整页也不滚；
//   3. 正文滚到底后，标题栏与保存栏的矩形一像素都没动，且都还在视口内。
//
// 运行：node web/tests/debug/explore-gate-modal-layout.mjs   (PORT=3000)
import { chromium } from "playwright-core";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "../../../.career-ops-web");
mkdirSync(SHOTS, { recursive: true });

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

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL ?? "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 620 } });
await page.addInitScript(() => {
  try {
    localStorage.setItem("career-ops:lang", "zh");
  } catch {}
});

/** 弹窗内「标题栏 / 保存栏 / 滚动容器」的矩形与滚动量，一次性读回来。 */
const measure = () =>
  page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-label="过滤配置"]');
    if (!dlg) return null;
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width) };
    };
    const header = dlg.querySelector("h2")?.parentElement;
    const footer = [...dlg.querySelectorAll("button")].find((b) => b.textContent.includes("保存到 portals.yml"))?.parentElement;
    // 滚动容器 = 弹窗内第一个真的能滚（内容高于自身）且 overflow-y 不是 visible 的后代。
    const scroller = [...dlg.querySelectorAll("*")].find((el) => {
      const oy = getComputedStyle(el).overflowY;
      return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
    });
    return {
      dialog: { ...rect(dlg), scrollHeight: dlg.scrollHeight, clientHeight: dlg.clientHeight },
      header: header ? rect(header) : null,
      footer: footer ? rect(footer) : null,
      scroller: scroller
        ? {
            ...rect(scroller),
            scrollTop: Math.round(scroller.scrollTop),
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
            inDialog: dlg.contains(scroller) && scroller !== dlg,
          }
        : null,
      pageScrollY: Math.round(window.scrollY),
    };
  });

let failed = false;
const check = (cond, msg) => {
  if (!cond) {
    failed = true;
    console.log(`[layout] FAIL: ${msg}`);
  } else {
    console.log(`[layout] ok: ${msg}`);
  }
};

try {
  await page.goto(`${BASE}/explore`, { waitUntil: "domcontentloaded" });
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, JSON.stringify(v)), [KEY, snap]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Alpha Beta").first().waitFor({ timeout: 20000 });

  await page.getByRole("button", { name: "配置" }).click();
  await page.locator('[aria-label="过滤配置"]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);

  const before = await measure();
  if (!before || !before.scroller) throw new Error(`弹窗没打开或正文没有可滚动区：${JSON.stringify(before)}`);
  await page.screenshot({ path: join(SHOTS, "verify-2026-10-31-gate-modal-layout-top.png") });

  // 1) 更宽的窗口：旧的 max-w-lg 是 32rem = 512px。
  check(before.dialog.width > 600, `弹窗变宽（实测 ${before.dialog.width}px，旧版 max-w-lg=512px）`);
  // 2) 滚动条在窗口内：滚动落在弹窗的子元素上，弹窗自己与整页都不滚。
  check(before.scroller.inDialog, "滚动区是弹窗内部的子元素，不是整页");
  check(before.dialog.scrollHeight <= before.dialog.clientHeight + 1, `弹窗自身不滚（scrollHeight=${before.dialog.scrollHeight} clientHeight=${before.dialog.clientHeight}）`);

  // 3) 滚到底，标题栏与保存栏不动。
  const scrollInfo = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-label="过滤配置"]');
    const scroller = [...dlg.querySelectorAll("*")].find((el) => {
      const oy = getComputedStyle(el).overflowY;
      return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
    });
    scroller.scrollTop = scroller.scrollHeight;
    return { moved: Math.round(scroller.scrollTop), max: scroller.scrollHeight - scroller.clientHeight };
  });
  await page.waitForTimeout(200);
  const after = await measure();
  if (!after || !after.scroller) throw new Error("滚动后读不到弹窗结构");
  await page.screenshot({ path: join(SHOTS, "verify-2026-10-31-gate-modal-layout-scrolled.png") });

  check(scrollInfo.moved > 0, `正文确实滚动了（scrollTop=${scrollInfo.moved} / max=${scrollInfo.max}）`);
  check(JSON.stringify(before.header) === JSON.stringify(after.header), `标题栏位置不动（${JSON.stringify(before.header)} → ${JSON.stringify(after.header)}）`);
  check(JSON.stringify(before.footer) === JSON.stringify(after.footer), `保存栏位置不动（${JSON.stringify(before.footer)} → ${JSON.stringify(after.footer)}）`);
  check(after.header.top >= 0 && after.footer.bottom <= 620, "滚到底后标题与保存按钮都还在视口内");
  check(after.pageScrollY === before.pageScrollY, `背后那页没被带着滚（${before.pageScrollY} → ${after.pageScrollY}）`);

  // 收尾：关弹窗即可，本脚本不点保存，portals.yml 一个字节都不动。
  await page.keyboard.press("Escape");
} catch (e) {
  failed = true;
  console.log(`[layout] ERROR: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
  console.log(failed ? "[layout] RESULT: FAIL" : "[layout] RESULT: PASS");
  process.exit(failed ? 1 : 0);
}
