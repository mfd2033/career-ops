// [DEBUG-a4f2] Repro loop #4 for:
//   「管道详情页：修改报告状态后，点击上一个/下一个，状态下拉框显示的值不对」
//
// Hypothesis: the user walks a STATUS-FILTERED tab (已评估 / 已放弃 …) and changes
// a row's status. That write removes the row from the tab, so on the next RSC
// render `orderApplications(rows, ctx)` no longer contains the id →
// web/src/app/pipeline/[id]/page.tsx:65-70 falls back to DEFAULT_ORDER (tab=ALL)
// → the 上一个/下一个 links (and the contextQuery they carry) silently switch to
// the WHOLE tracker. The user keeps clicking 下一个 expecting their queue and
// lands on an unrelated report, whose 状态下拉框 shows that report's status.
//
// ZERO WRITES. The post-change page state is reproduced exactly: the URL still
// carries the ORIGINAL tab while the row no longer matches it — which is
// literally the state `data/status-log.tsv`'s most recent entry left behind
// (that ledger is private/untracked, so this reads it at run time instead of
// pasting a row into the repo).
//
// Run: node web/tests/debug/status-tab-departure-fallback.mjs   (PORT=3000)

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
const all = orderApplications(rows, DEFAULT_ORDER);
const TAB = (process.env.TAB ?? "EVALUATED").toUpperCase();
const ctx = { ...DEFAULT_ORDER, tab: TAB };
const evaluated = orderApplications(rows, ctx);
log(`ALL rows: ${all.length} | ${TAB}-tab rows: ${evaluated.length}`);

// The row whose status was LAST changed through the web (the user's own last
// action), or ROW=… to frame a specific one. Read from the append-only ledger.
const fs = await import("node:fs");
const ledger = fs.readFileSync(path.join(WEB_DIR, "..", "data", "status-log.tsv"), "utf8").trim().split("\n");
const last = ledger[ledger.length - 1].split("\t");
const [lastRow, lastDate, lastFrom, lastTo] = last;
const ROW = String(process.env.ROW ?? lastRow);
if (ROW === lastRow) log(`last ledger entry: #${lastRow} ${lastDate} ${lastFrom} → ${lastTo}`);
else {
  const hit = ledger.map((l) => l.split("\t")).find(([n]) => n === ROW);
  log(`ledger entry for #${ROW}: ${hit ? hit.join(" ") : "(none)"}`);
}
const lastRowN = ROW;
// The row left the tab, so its URL still says ?tab=<TAB> while it no longer
// matches — the exact post-write state.
const departed = rows.find((r) => String(r.n) === String(lastRowN));
const allIdx = all.findIndex((a) => String(a.n) === String(lastRowN));
const allNext = all[allIdx + 1];
log(`#${lastRowN} (${departed?.company}) is now ${departed?.status}; in the ALL list it sits at position ${allIdx + 1} of ${all.length}, next = #${allNext?.n} ${allNext?.company} (${allNext?.status})`);

// An in-tab control row: still matching the tab, so ?tab=<TAB> keeps the nav
// inside the tab (the behaviour BEFORE the write).
const inTab = evaluated[Math.floor(evaluated.length / 2)];
const evIdx = evaluated.findIndex((a) => a.n === inTab.n);
log(`control row still inside the tab: #${inTab.n} ${inTab.company} (${inTab.status}) at ${TAB} position ${evIdx + 1} of ${evaluated.length}`);

const browser = await chromium.launch();
const page = await browser.newPage();
let green = false;

const select = () => page.locator("select").first();
const nextLink = () => page.locator('nav > a[href^="/pipeline/"]:last-child');
const position = () => page.locator("nav span.tabular-nums").first().innerText().catch(() => "");

async function open(url) {
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  await select().waitFor({ state: "visible", timeout: 60_000 });
  return {
    url: page.url(),
    position: norm(await position()),
    value: await select().inputValue(),
    nextHref: await nextLink().getAttribute("href").catch(() => null),
  };
}

try {
  // --- control: a row still matching the tab ---------------------------------
  const c = await open(`${ORIGIN}/pipeline/${inTab.n}?tab=${TAB}`);
  log(`control /pipeline/${inTab.n}?tab=${TAB} → position=${JSON.stringify(c.position)}, select=${JSON.stringify(c.value)}, 下一个 href=${JSON.stringify(c.nextHref)}`);
  const cStayedInTab = String(c.nextHref).includes(`tab=${TAB}`);
  const cTotal = norm(c.position).split("/")[1]?.trim();
  log(`control stays inside the tab: ${cStayedInTab} (href carries tab=${TAB}; total shown = ${cTotal} vs tab size ${evaluated.length})`);

  // --- the user's post-write state -------------------------------------------
  const p = await open(`${ORIGIN}/pipeline/${lastRowN}?tab=${TAB}`);
  log(`post-write /pipeline/${lastRowN}?tab=${TAB} → position=${JSON.stringify(p.position)}, select=${JSON.stringify(p.value)}, 下一个 href=${JSON.stringify(p.nextHref)}`);
  const pSwitchedToAll = String(p.nextHref).includes("tab=ALL");
  const pTotal = norm(p.position).split("/")[1]?.trim();
  log(`nav context silently switched to ALL: ${pSwitchedToAll} (href=${p.nextHref}, position total = ${pTotal} vs tab size ${evaluated.length})`);

  // What the user gets when they click 下一个 to continue their queue:
  await nextLink().click({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  const landedId = new URL(page.url()).pathname.match(/^\/pipeline\/(\d+)/)?.[1] ?? null;
  const landed = rows.find((r) => String(r.n) === String(landedId));
  const landedValue = await select().inputValue();
  const landedPosition = norm(await position());
  log(`clicked 下一个 → /pipeline/${landedId} ${landed?.company} (${landed?.status}), position=${JSON.stringify(landedPosition)}, select=${JSON.stringify(landedValue)}`);
  log(`expected a row from the ${TAB} queue (tab size ${evaluated.length}); got the ALL-list neighbour #${allNext?.n} (${landedValue})`);

  const landedIsAllNeighbour = String(landedId) === String(allNext?.n);
  green = cStayedInTab && !pSwitchedToAll;
  console.log("\n========== VERDICT ==========");
  if (green) {
    console.log("GREEN: the tab context survives a row leaving the tab");
  } else {
    console.log("RED: after a status change removes the row from the current tab, the detail page silently");
    console.log("     drops the tab context and re-points 上一个/下一个 (and the ?tab= they carry) at the WHOLE tracker.");
    console.log(`  control (row still in tab): 下一个 href=${JSON.stringify(c.nextHref)} (stays in ${TAB}, ${evaluated.length} rows)`);
    console.log(`  after the write (#${lastRowN} left ${TAB}): 下一个 href=${JSON.stringify(p.nextHref)} → position ${JSON.stringify(p.position)} (ALL, ${all.length} rows)`);
    console.log(`  so the next 下一个 click lands on #${landedId} ${landed?.company} (${landedValue}) — not the next ${TAB} row —`);
    console.log(`  and the user sees 状态下拉框 = ${JSON.stringify(landedValue)} instead of a row from the queue they were walking.`);
    console.log(`  (landed on the ALL-list neighbour: ${landedIsAllNeighbour})`);
  }
  console.log("=============================\n");
} finally {
  await browser.close().catch(() => {});
  setTimeout(() => process.exit(green ? 0 : 1), 300);
}
