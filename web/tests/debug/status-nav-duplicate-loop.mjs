// [DEBUG-a4f2] Repro loop #3 for:
//   「管道详情页：修改报告状态后，点击上一个/下一个，状态下拉框显示的值不对」
//
// Focus: the prev/next NAVIGATION around the duplicate tracker row #432.
// data/applications.md holds #432 twice. The detail page computes
//   index = ordered.findIndex(a => a.n === id)   // always the FIRST copy
//   next  = ordered[index + 1]
// so the row sitting IMMEDIATELY BEFORE the second copy has a 下一个 link that
// points at `/pipeline/432` — the FIRST copy's page. Result: 下一个 jumps
// BACKWARD (position 153 → 137) and the 137…153 range becomes a closed loop
// (the forward chain 137→…→152→137 never reaches 154+).
//
// ZERO WRITES: this loop never touches /api/status.
//
// Run: node web/tests/debug/status-nav-duplicate-loop.mjs   (PORT=3000)

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "..");
const PORT = Number(process.env.PORT ?? 3000);
const ORIGIN = `http://localhost:${PORT}`;
const TAG = "[DEBUG-a4f2]";
const log = (...a) => console.log(TAG, ...a);
const norm = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

const { orderApplications, DEFAULT_ORDER } = await import(pathToFileURL(path.join(WEB_DIR, "src", "lib", "pipeline-order.mjs")).href);

const pipeline = await (await fetch(`${ORIGIN}/api/pipeline`)).json();
const rows = pipeline.applications ?? [];
const ordered = orderApplications(rows, DEFAULT_ORDER);
const counts = new Map();
for (const r of rows) counts.set(String(r.n), (counts.get(String(r.n)) ?? 0) + 1);
const dupIds = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n);
log(`ordered rows: ${ordered.length} | duplicate ids: ${JSON.stringify(dupIds)}`);

// ROW=<n> pins the page under test (post-dedup there is no duplicate left to
// derive it from — pass the row that used to sit before the duplicate, #16).
const DUP = dupIds[0] ?? null;
let START_ROW = process.env.ROW ? String(process.env.ROW) : null;
if (!START_ROW) {
  if (!DUP) throw new Error("no duplicate tracker row and no ROW=<n> given — nothing to point the loop at");
  START_ROW = String(ordered[ordered.map((a, i) => (String(a.n) === DUP ? i : -1)).filter((i) => i >= 0)[1] - 1]?.n);
}
if (DUP) {
  const dupIdx = ordered.map((a, i) => (String(a.n) === DUP ? i : -1)).filter((i) => i >= 0);
  log(`duplicate #${DUP} sits at ordered indices ${dupIdx.join(", ")} (positions ${dupIdx.map((i) => i + 1).join(", ")} of ${ordered.length})`);
  log(`but looking up #${DUP} resolves to the FIRST copy at ordered[${dupIdx[0]}] (position ${dupIdx[0] + 1})`);
} else {
  log("no duplicate rows left in the tracker — expecting a clean one-step advance everywhere");
}
const startIdx = ordered.findIndex((a) => String(a.n) === START_ROW);
const before = ordered[startIdx];
const after = ordered[startIdx + 1];
log(`page under test: #${before.n} ${before.company} (${before.status}) at position ${startIdx + 1} — its 下一个 should advance to #${after?.n} ${after?.company} (${after?.status})`);

// A control pair whose two statuses differ — proves the normal nav path (and the
// dropdown it renders) is correct on this same running app.
let ctrl = null;
for (let i = 0; i + 1 < ordered.length; i++) {
  if (String(ordered[i].n) === DUP || String(ordered[i + 1].n) === DUP) continue;
  if (ordered[i].status !== ordered[i + 1].status) {
    ctrl = { a: ordered[i], b: ordered[i + 1], i };
    break;
  }
}
log(`control pair: #${ctrl.a.n} ${ctrl.a.company} (${ctrl.a.status}, pos ${ctrl.i + 1}) → #${ctrl.b.n} ${ctrl.b.company} (${ctrl.b.status}, pos ${ctrl.i + 2})`);

const browser = await chromium.launch();
const page = await browser.newPage();
let green = false;

const select = () => page.locator("select").first();
const nextLink = () => page.locator('nav > a[href^="/pipeline/"]:last-child');
const position = () => page.locator("nav span.tabular-nums").first().innerText().catch(() => "");

async function open(n) {
  await page.goto(`${ORIGIN}/pipeline/${n}`, { waitUntil: "load", timeout: 120_000 });
  await select().waitFor({ state: "visible", timeout: 60_000 });
  return {
    url: page.url(),
    position: norm(await position()),
    value: await select().inputValue(),
    nextHref: await nextLink().getAttribute("href").catch(() => null),
  };
}

try {
  // --- the duplicate's neighbourhood ---------------------------------------
  const start = await open(before.n);
  log(`opened /pipeline/${before.n} — position=${JSON.stringify(start.position)}, select=${JSON.stringify(start.value)}, 下一个 href=${JSON.stringify(start.nextHref)}`);

  const urlBeforeClick = page.url();
  await nextLink().click({ timeout: 30_000 });
  await page.waitForURL((u) => u.pathname !== new URL(urlBeforeClick).pathname, { timeout: 60_000 });
  await page.waitForTimeout(500);
  const jumped = {
    url: page.url(),
    position: norm(await position()),
    value: await select().inputValue(),
  };
  log(`after clicking 下一个: url=${jumped.url}, position=${JSON.stringify(jumped.position)}, select=${JSON.stringify(jumped.value)}`);

  const startPos = Number(start.position.match(/^(\d+)/)?.[1] ?? NaN);
  const jumpedPos = Number(jumped.position.match(/^(\d+)/)?.[1] ?? NaN);
  const advanced = jumpedPos === startPos + 1;
  const landedId = new URL(jumped.url).pathname.match(/^\/pipeline\/(\d+)/)?.[1] ?? null;
  log(`expected to advance to position ${startPos + 1}; landed at ${jumpedPos} (row #${landedId}) → ${advanced ? "advances" : "JUMPS BACK"}`);

  // --- control: a normal neighbouring pair ----------------------------------
  const ca = await open(ctrl.a.n);
  const caOk = ca.value === ctrl.a.status && norm(ca.position).startsWith(String(ctrl.i + 1));
  await nextLink().click({ timeout: 30_000 });
  await page.waitForURL((u) => u.pathname !== new URL(ca.url).pathname, { timeout: 60_000 });
  await page.waitForTimeout(500);
  const cb = { url: page.url(), position: norm(await position()), value: await select().inputValue() };
  const cbOk = cb.value === ctrl.b.status;
  log(`control: on #${ctrl.a.n} select=${JSON.stringify(ca.value)} (truth ${JSON.stringify(ctrl.a.status)}, pos ${JSON.stringify(ca.position)}) → after 下一个 landed #${new URL(cb.url).pathname.match(/^\/pipeline\/(\d+)/)?.[1]} pos ${JSON.stringify(cb.position)} select=${JSON.stringify(cb.value)} (truth ${JSON.stringify(ctrl.b.status)}) → ${cbOk ? "correct" : "WRONG"}`);

  green = advanced && caOk && cbOk;
  console.log("\n========== VERDICT ==========");
  if (green) {
    console.log("GREEN: 下一个 advances by exactly one position everywhere");
  } else {
    console.log("RED: 下一个 does not advance by exactly one position.");
    console.log(`  #${before.n} (pos ${startPos}) links 下一个 → /pipeline/${landedId}, landing at pos ${jumpedPos}`);
    console.log(`  (a duplicated tracker number resolves back to its FIRST copy, so the page jumps backwards)`);
    console.log(`  expected #${after?.n} (pos ${startPos + 1}); the dropdown shows ${JSON.stringify(jumped.value)} instead of ${JSON.stringify(after?.status)}.`);
    console.log(`  positions ${dupIdx[0] + 1}…${dupIdx[1] + 1} form a closed loop reachable by 下一个; ${dupIdx[1] + 2}+ is unreachable from below.`);
    console.log(`  control (normal pair #${ctrl.a.n}→#${ctrl.b.n}): ${cbOk ? "the dropdown shows the landed row's own status — the plain nav path is fine" : "also wrong"}`);
  }
  console.log("=============================\n");
} finally {
  await browser.close().catch(() => {});
  setTimeout(() => process.exit(green ? 0 : 1), 300);
}
