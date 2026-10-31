// 行为验证：标题门弹窗里的词条可点击改名；与同组已有词重名时，当场提示并拒绝落改。
//
// 为什么要有这个脚本：gate-panel.test.mjs 只能锁源码形状（仓里没有组件渲染基建，
// ADR-0072 known gap），而「点 chip → 输入框 → 打字 → 提示/落改」这条全靠 DOM 行为。
// 形状对上、行为不对（比如重名提示根本不出现，或 Esc 顺手把整个弹窗关掉）是这类
// 交互最常见的坏法，所以这里按真浏览器跑一遍。
//
// 断言（固定快照，不触发扫描，只写 sessionStorage，不碰 portals.yml）：
//   1. 点词 → 就地变输入框，预填原词；
//   2. 输入另一个同组已有的词 → 「已在词表里」提示出现，回车不落改，编辑态留着；
//   3. 改成新词 → 回车落改：chip 变新词、提示消失、保存按钮变可用（草稿有差异）；
//   4. 编辑态里按 Esc 只撤这次改名，弹窗仍然开着（不能连草稿一起关掉）。
//
// 运行：node web/tests/debug/explore-gate-chip-rename.mjs   (PORT=3000)
import { chromium } from "playwright-core";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 截例固定落在仓内的 .career-ops-web/（与其余 verify-*.png 同一处），不随 cwd 飘。
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

const NEW_WORD = "重命名测试词";

// 本机只装了 Edge、ms-playwright 里也没有 chromium 包，于是借系统浏览器跑（PW_CHANNEL 可换）。
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL ?? "msedge" });
const page = await browser.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("career-ops:lang", "zh");
  } catch {}
});

/** 弹窗里某一组（白名单/黑名单）的词条文本，按屏幕顺序。 */
const groupWords = (prefix) =>
  page.evaluate((p) => {
    const dlg = document.querySelector('[role="dialog"][aria-label="过滤配置"]');
    if (!dlg) return null;
    const group = [...dlg.querySelectorAll("div")].find((d) => d.querySelector(":scope > p")?.textContent?.trim().startsWith(p));
    if (!group) return null;
    return [...group.querySelectorAll('button[title^="点击改名："]')].map((b) => b.textContent.trim());
  }, prefix);

const dialogOpen = () => page.evaluate(() => !!document.querySelector('[role="dialog"][aria-label="过滤配置"]'));
const editing = () => page.locator('[role="dialog"][aria-label="过滤配置"] input[aria-label^="改名 "]').count();
/** 点某一枚 chip：按可见文字精确匹配（title 是整句提示，「软件」会前缀命中「软件产品」）。 */
const chip = (w) => page.locator('[role="dialog"]').getByRole("button", { name: w, exact: true });

let failed = false;
const check = (cond, msg) => {
  if (!cond) {
    failed = true;
    console.log(`[rename] FAIL: ${msg}`);
  } else {
    console.log(`[rename] ok: ${msg}`);
  }
};

try {
  await page.goto(`${BASE}/explore`, { waitUntil: "domcontentloaded" });
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, JSON.stringify(v)), [KEY, snap]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Alpha Beta").first().waitFor({ timeout: 20000 });

  await page.getByRole("button", { name: "配置" }).click();
  await page.locator('[aria-label="过滤配置"]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(200);

  // 白名单优先（界面第一组），词不够两个就换黑名单。
  let words = (await groupWords("白名单")) ?? [];
  let prefix = "白名单";
  if (words.length < 2) {
    words = (await groupWords("黑名单")) ?? [];
    prefix = "黑名单";
  }
  if (words.length < 2) throw new Error(`${prefix}组里不足两个词，无法验证重名（词表=${JSON.stringify(words)}）`);
  const [first, second] = words;
  console.log(`[rename] 目标组=${prefix} 词条=${JSON.stringify(words.slice(0, 5))}`);

  // 1) 点词 → 输入框，预填原词。
  await chip(first).first().click();
  const input = page.locator('[role="dialog"] input[aria-label^="改名 "]');
  await input.waitFor({ timeout: 3000 });
  check((await input.inputValue()) === first, `点「${first}」后输入框预填原词（实际「${await input.inputValue()}」）`);

  // 2) 输入另一个已有词 → 提示出现，回车不落改。
  await input.fill(second);
  const hint = page.locator('[role="dialog"] p', { hasText: `「${second}」已在词表里` });
  check((await hint.count()) > 0, `输入已在表里的「${second}」时出现重名提示`);
  await page.screenshot({ path: join(SHOTS, "verify-2026-10-31-gate-chip-rename-duplicate.png") });
  await input.press("Enter");
  await page.waitForTimeout(150);
  check((await editing()) === 1, "重名时空格回车不落改：仍留在编辑态");
  // 编辑中的那一条此刻以输入框形态存在，所以按「其余条目」比：不能多出一条同名词。
  const afterDup = await groupWords(prefix);
  check(
    afterDup.length === words.length - 1 && afterDup.filter((w) => w === second).length === words.filter((w) => w === second).length,
    "重名被拒：草稿里没多出第二条同名词",
  );
  await input.press("Escape");
  await page.waitForTimeout(150);
  check(JSON.stringify(await groupWords(prefix)) === JSON.stringify(words), "退出编辑后词表与原来逐条一致（拒改真的没落）");
  await chip(first).first().click();

  // 3) 改成新词 → 回车落改，chip 变新词，保存按钮变可用。
  await input.fill(NEW_WORD);
  check((await hint.count()) === 0, "改成不重复的新词后提示消失");
  await input.press("Enter");
  await page.waitForTimeout(150);
  const renamed = await groupWords(prefix);
  check(renamed.includes(NEW_WORD) && !renamed.includes(first), `回车后「${first}」改名为「${NEW_WORD}」`);
  const saveBtn = page.getByRole("button", { name: /保存到 portals\.yml/ });
  check(await saveBtn.isEnabled(), "草稿与已存表不同 → 保存按钮变可用（改名走的是同一条保存回路）");
  await page.screenshot({ path: join(SHOTS, "verify-2026-10-31-gate-chip-rename.png") });

  // 4) 编辑态 Esc 只撤这次改名，弹窗不关。
  await chip(second).first().click();
  await page.locator('[role="dialog"] input[aria-label^="改名 "]').waitFor({ timeout: 3000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check((await dialogOpen()) && (await editing()) === 0, "编辑态按 Esc 只退出编辑，弹窗与其余草稿都还在");

  // 收尾：放弃改动（本脚本绝不点保存，portals.yml 一个字节都不动）。
  await page.getByRole("button", { name: "放弃改动" }).click();
  await page.waitForTimeout(150);
  check(!(await groupWords(prefix)).includes(NEW_WORD), "「放弃改动」把草稿复位到已存表（改名也一样不落盘）");
} catch (e) {
  failed = true;
  console.log(`[rename] ERROR: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close();
  console.log(failed ? "[rename] RESULT: FAIL" : "[rename] RESULT: PASS");
  process.exit(failed ? 1 : 0);
}
