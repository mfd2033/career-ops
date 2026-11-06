// 行为验证：报告页「状态记录」弹窗是否落在视口正中（而不是整页内容的中间）。
//
// 为什么要有这个脚本：弹窗外层写的是 `fixed inset-0`，看起来必然贴住视口；但只要
// 任一祖先的 computed transform 不是 none，fixed 的包含块就变成那个祖先的 padding
// box。报告页很长（几千 px），此时遮罩会铺满整篇内容，弹窗被居中到页面中段——
// 视口里根本看不到，用户只能滚很久才发现。源码形状锁不住这类几何，必须在真浏览器里量。
//
// 断言（只读，不写任何数据；点开弹窗后直接 Escape 关掉）：
//   1. 遮罩矩形覆盖视口（top≈0、bottom≈视口高）；
//   2. 弹窗纵向中心≈视口中心，且弹窗完整落在视口内；
//   3. 弹窗没有被任何 transform/filter 祖先困住（诊断信息，出问题时报出来）。
//
// 运行：node web/tests/debug/report-status-history-modal-position.mjs   (PORT=3000)
import { chromium } from "playwright-core";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "../../../.career-ops-web");
mkdirSync(SHOTS, { recursive: true });

const PORT = Number(process.env.PORT ?? 3101);
const BASE = `http://localhost:${PORT}`;
const REPORT_ID = process.env.REPORT_ID ?? "1";
const VIEWPORT = { width: 1440, height: 780 };

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL ?? "msedge" });
const page = await browser.newPage({ viewport: VIEWPORT });
await page.addInitScript(() => {
  try {
    localStorage.setItem("career-ops:lang", "zh");
  } catch {}
});

/** 遮罩 + 弹窗的矩形，以及把 fixed 变成「相对祖先」的那些祖先。 */
const measure = () =>
  page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-label="状态变化记录"]');
    if (!dlg) return null;
    const overlay = dlg.parentElement;
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return {
        top: Math.round(b.top),
        bottom: Math.round(b.bottom),
        left: Math.round(b.left),
        right: Math.round(b.right),
        width: Math.round(b.width),
        height: Math.round(b.height),
      };
    };
    // 逐级向上找：谁把 fixed 的包含块从「视口」改成了自己。
    const trappingAncestors = [];
    for (let el = overlay.parentElement; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const trapping =
        (cs.transform && cs.transform !== "none") ||
        (cs.filter && cs.filter !== "none") ||
        (cs.backdropFilter && cs.backdropFilter !== "none") ||
        (cs.perspective && cs.perspective !== "none") ||
        (cs.contain && cs.contain !== "none") ||
        (cs.willChange && /transform|filter|perspective/.test(cs.willChange));
      if (trapping) {
        trappingAncestors.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className).slice(0, 80),
          transform: cs.transform,
          animation: cs.animationName,
          height: Math.round(el.getBoundingClientRect().height),
        });
      }
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pageHeight: Math.round(document.documentElement.scrollHeight),
      scrollY: Math.round(window.scrollY),
      overlay: r(overlay),
      dialog: r(dlg),
      trappingAncestors,
    };
  });

let failed = false;
const check = (cond, msg) => {
  if (!cond) {
    failed = true;
    console.log(`[pos] FAIL: ${msg}`);
  } else {
    console.log(`[pos] ok: ${msg}`);
  }
};

try {
  await page.goto(`${BASE}/pipeline/${REPORT_ID}`, { waitUntil: "domcontentloaded" });
  const btn = page.getByRole("button", { name: "状态记录" });
  await btn.waitFor({ timeout: 60000 });
  await page.waitForTimeout(600); // 让 page-enter 入场动画跑完

  await btn.click();
  await page.locator('[role="dialog"][aria-label="状态变化记录"]').waitFor({ timeout: 10000 });
  await page.waitForTimeout(200);

  const m = await measure();
  if (!m) throw new Error("点开状态记录后读不到弹窗");
  await page.screenshot({ path: join(SHOTS, "debug-report-status-history-modal.png") });
  console.log(`[pos] 视口 ${JSON.stringify(m.viewport)} / 整页高 ${m.pageHeight}px / scrollY ${m.scrollY}`);
  console.log(`[pos] 遮罩 ${JSON.stringify(m.overlay)}`);
  console.log(`[pos] 弹窗 ${JSON.stringify(m.dialog)}`);
  if (m.trappingAncestors.length) console.log(`[pos] 困住 fixed 的祖先 ${JSON.stringify(m.trappingAncestors)}`);

  check(m.overlay.top === 0 && m.overlay.bottom === m.viewport.height, "遮罩矩形贴合视口（top=0, bottom=视口高）");
  const dialogCenter = (m.dialog.top + m.dialog.bottom) / 2;
  const viewportCenter = m.viewport.height / 2;
  check(
    Math.abs(dialogCenter - viewportCenter) <= 4,
    `弹窗纵向居中于视口（弹窗中心 ${Math.round(dialogCenter)}px vs 视口中心 ${viewportCenter}px）`,
  );
  check(m.dialog.top >= 0 && m.dialog.bottom <= m.viewport.height, "弹窗完整落在视口内（不用滚动就能看到）");

  // 报告页很长，用户通常在滚到中段时才点这枚按钮——位置要跟视口走，不跟文档走。
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(150);
  // 不用 page.click：Playwright 会先把按钮滚进视口，等于把刚才的滚动撤销掉。
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("状态记录"));
    b?.click();
  });
  await page.locator('[role="dialog"][aria-label="状态变化记录"]').waitFor({ timeout: 10000 });
  await page.waitForTimeout(200);
  const scrolled = await measure();
  if (!scrolled) throw new Error("滚到中段后点开状态记录读不到弹窗");
  await page.screenshot({ path: join(SHOTS, "debug-report-status-history-modal-scrolled.png") });
  console.log(`[pos] 滚动后 scrollY ${scrolled.scrollY} / 遮罩 ${JSON.stringify(scrolled.overlay)} / 弹窗 ${JSON.stringify(scrolled.dialog)}`);
  check(scrolled.overlay.top === 0 && scrolled.overlay.bottom === scrolled.viewport.height, "滚动到中段后遮罩仍贴合视口");
  const scrolledCenter = (scrolled.dialog.top + scrolled.dialog.bottom) / 2;
  check(
    Math.abs(scrolledCenter - scrolled.viewport.height / 2) <= 4,
    `滚动到中段后弹窗仍纵向居中（弹窗中心 ${Math.round(scrolledCenter)}px vs 视口中心 ${scrolled.viewport.height / 2}px）`,
  );
  check(scrolled.trappingAncestors.length === 0, "没有祖先把 fixed 的包含块从视口夺走");

  await page.keyboard.press("Escape");
} catch (e) {
  failed = true;
  console.log(`[pos] ERROR: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
  console.log(failed ? "[pos] RESULT: FAIL" : "[pos] RESULT: PASS");
  process.exit(failed ? 1 : 0);
}
