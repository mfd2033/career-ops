// [DEBUG-harness] Regression loop for:
//   「侧栏工作器列表 与 /jobs 历史页 显示的用时数据，需要刷新页面才显示真实时间」
//
// Pre-fix root cause (proven red, 2026-09): `web/src/lib/eval-duration-client.ts`
// cached /api/eval-durations + /api/report-status in a module-level promise map that
// was NEVER invalidated for the life of the page. A card's first render happens while
// its CLI is still running, so the cached indexes predate the very rows the run then
// writes (data/eval-timings.tsv + the tracker). On `done`, `entry` stayed null and
// `doneDurationSeconds` fell back to the local startedAt→endedAt wall clock (which
// also carries queue + spawn overhead); the real 评估用时 only appeared after a reload
// re-created the module. Measured: request counts {evalDurations:1, reportStatus:1}
// while a fresh read resolved the report correctly — the join was never the problem,
// only the one-shot cache.
//
// Post-fix: the cache entry is dropped on the `co-job-done` event (jsdom-free proof —
// both surfaces show 12m34s after ONE extra fetch per index, no reload).
//
// Loop shape (no real CLI, no tokens spent):
//   1. `next dev --webpack` on localhost:3100 from web/, with distDir=.next-dbg so the
//      live .next / the packaged standalone runtime on :3000 is never touched.
//   2. Playwright page.routes stub the whole worker backend:
//        POST /api/run            → { runId }   (its body names the posting URL)
//        GET  /api/events         → HOLDS the NDJSON channel, then one `done` frame
//        GET  /api/report-status  → {} until release, then the URL → report #N mapping
//        GET  /api/eval-durations → {} until release, then report #N duration 754s
//   3. The harness opens a real report page, clicks 重新评估 (a kind:"evaluate" worker),
//      then releases the backend and asserts the sidebar card — and, after a
//      CLIENT-SIDE nav to /jobs, the history row — shows 12m34s (the TSV value) rather
//      than the local fallback. Nothing reloads the page: a reload re-fetches the
//      indexes and would "fix" the symptom, which is exactly the bug under test.
//
// Run: node web/tests/debug/eval-duration-stale-refresh.mjs
// (REPRO_VERBOSE=1 for next-dev output.)
//
// NOTE: leaves web/.next-dbg behind on purpose (gitignored, reload-speed cache);
// delete it when the debugging session is over.
//
// NOTE: a real F5 is NOT usable as the green control here — `next dev` runs StrictMode,
// whose double-invoked effects make the job-store's restore/persist pair wipe the
// restored worker list on load (dev-only; production ordering is fine). The harness
// controls for that with a direct index read instead.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "..");
const DIST_DIR = ".next-dbg";
const PORT = 3100;
const ORIGIN = `http://localhost:${PORT}`;

const RUN_ID = "repro-eval-run";
const TRUE_DURATION = 754; // seconds → fmtDuration → 12m34s
const EXPECTED = "12m34s";
const SETTLE_WAIT_MS = 12_000;

const log = (...a) => console.log("[repro]", ...a);

const { normalizeUrl } = await import(
  pathToFileURL(path.join(WEB_DIR, "src", "lib", "core", "url-key.mjs")).href
);

// --- 1. dev server ----------------------------------------------------------
// `next dev` appends the distDir's generated types to tsconfig `include`; snapshot the
// file so the throwaway distDir can never leak into the working tree (it does not know
// about .next-dbg otherwise).
const TSCONFIG = path.join(WEB_DIR, "tsconfig.json");
const tsconfigBefore = fs.readFileSync(TSCONFIG, "utf8");

const dev = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--webpack", "-p", String(PORT)],
  { cwd: WEB_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BUILD_DIST: DIST_DIR } },
);
dev.stdout.on("data", (d) => process.env.REPRO_VERBOSE && process.stdout.write("[next] " + d));
dev.stderr.on("data", (d) => process.env.REPRO_VERBOSE && process.stderr.write("[next!] " + d));

async function waitReady(url, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`dev server not ready after ${timeoutMs}ms`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function waitFor(pred, { timeoutMs = 15_000, label = "condition", intervalMs = 200 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// --- 2. backend stubs -------------------------------------------------------
// Flipped by the harness once the worker card has done its FIRST index fetch, so a
// re-read after the worker settles is the only way the TSV number can ever appear.
let released = false;
let reportKey = null; // normalizeUrl(posting URL) — learned from the POST /api/run body
let reportNum = null; // the tracker row we opened
const counts = { evalDurations: 0, reportStatus: 0, run: 0, events: 0, activeRuns: 0 };
const pendingEvents = []; // per-connection release flags; the LAST one gets the done frame

const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

function installStubs(page) {
  page.on("pageerror", (e) => log("page-error:", String(e).slice(0, 300)));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("/api/logo")) {
      log("http", r.status(), r.request().method(), r.url().slice(0, 160));
    }
  });

  return Promise.all([
    page.route("**/api/eval-durations", (route) => {
      counts.evalDurations++;
      return route.fulfill(
        json(
          released && reportNum
            ? {
                [reportNum]: {
                  duration: TRUE_DURATION,
                  steps: [{ step: "eval", seconds: TRUE_DURATION }],
                  finishedAt: "2026-09-13 12:34",
                },
              }
            : {},
        ),
      );
    }),
    page.route("**/api/report-status", (route) => {
      counts.reportStatus++;
      return route.fulfill(json(released && reportKey ? { [reportKey]: { score: "4", reportNum } } : {}));
    }),
    page.route("**/api/active-runs", (route) => {
      counts.activeRuns++;
      return route.fulfill(json({ running: [], queued: [] }));
    }),
    page.route("**/api/run", async (route) => {
      counts.run++;
      try {
        const body = route.request().postDataJSON();
        if (body?.input) reportKey = normalizeUrl(body.input);
      } catch {
        /* body already consumed */
      }
      return route.fulfill(json({ runId: RUN_ID }));
    }),
    page.route("**/api/runs/save", (route) => route.fulfill(json({}))),
    // The multiplexed worker-event channel (ADR-0020): every connection parks here
    // until the harness releases, then exactly one of them gets the `done` frame.
    page.route("**/api/events", async (route) => {
      counts.events++;
      const slot = { frame: "keepalive" };
      pendingEvents.push(slot);
      await new Promise((resolve) => (slot.resolve = resolve));
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/x-ndjson",
          body:
            JSON.stringify(slot.frame === "done" ? { runId: RUN_ID, type: "done", tokens: 11, costUsd: 0.01 } : { type: "keepalive" }) +
            "\n",
        });
      } catch {
        /* page navigated away mid-hold */
      }
    }),
  ]);
}

/** Open a URL and wait until the client app has mounted (job-store opens /api/events). */
async function gotoHydrated(url) {
  const before = counts.events;
  await page.goto(url, { waitUntil: "load", timeout: 180_000 });
  await waitFor(() => counts.events > before, { timeoutMs: 90_000, label: `hydration of ${url}` });
}

// --- 3. main ----------------------------------------------------------------
let browser;
let page;
let green = false;
try {
  log("waiting for dev server on :" + PORT + " (first compile can take a while)…");
  await waitReady(`${ORIGIN}/api/version`, 240_000);

  browser = await chromium.launch();
  page = await browser.newPage();
  await installStubs(page);

  // The worker POSTs /api/run with the saved CLI id — seed it so no detection round-trip.
  await page.addInitScript(() => {
    localStorage.setItem("career-ops:config", JSON.stringify({ mode: "cli", cliId: "claude" }));
  });

  // Collect candidate report pages from the home "Awaiting your decision" cards.
  await gotoHydrated(`${ORIGIN}/`);
  const hrefs = await page.locator('main a[href^="/pipeline/"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("href")),
  );
  const candidates = [...new Set(hrefs.filter((h) => /^\/pipeline\/\d+$/.test(h)))];
  log("report candidates:", JSON.stringify(candidates));
  if (candidates.length === 0) throw new Error("no report links on the home page — cannot start a worker");

  // Find a report whose 重新评估 button is enabled (i.e. its report carries a URL).
  let started = false;
  for (const href of candidates) {
    await gotoHydrated(ORIGIN + href);
    const btn = page.getByRole("button", { name: /重新评估|Re-evaluate/ }).first();
    if (!(await btn.count())) continue;
    if (await btn.isDisabled()) {
      log("skip (no posting URL in report):", href);
      continue;
    }
    reportNum = href.match(/(\d+)$/)[1];
    const base = { ...counts };
    await btn.click(); // startJob({kind:"evaluate", input:url}) — the worker card mounts here
    log("started an evaluate worker from", href, "→ report", reportNum);

    await waitFor(() => counts.run > base.run, { label: "POST /api/run" });
    await waitFor(() => counts.evalDurations > base.evalDurations && counts.reportStatus > base.reportStatus, {
      label: "the card's first index fetch",
    });
    const firstFetch = { ...counts };
    log("first index fetch (still the stale/empty index):", JSON.stringify(firstFetch));
    started = true;
    break;
  }
  if (!started) throw new Error("every candidate report lacked a posting URL — cannot start a worker");
  if (!reportKey) throw new Error("could not learn the posting URL from POST /api/run");

  // The evaluation "finishes" now: data/eval-timings.tsv + the tracker gain report N.
  released = true;
  pendingEvents[pendingEvents.length - 1].frame = "done";
  for (const s of pendingEvents) s.resolve();
  log(`released the done frame; expecting the worker surfaces to show ${EXPECTED}…`);

  const norm = (t) => t.replace(/\s+/g, " ");
  const aside = page.locator("aside").first();

  let sawSidebar = false;
  try {
    await waitFor(
      async () => (sawSidebar = norm(await aside.innerText().catch(() => "")).includes(EXPECTED)),
      { timeoutMs: SETTLE_WAIT_MS, label: `sidebar 用时 == ${EXPECTED}` },
    );
  } catch {
    /* verdict below */
  }
  log("sidebar card after settle:", JSON.stringify(norm(await aside.innerText().catch(() => ""))));
  log(
    "ls[jobs] after settle:",
    JSON.stringify(await page.evaluate(() => (localStorage.getItem("career-ops:jobs") || "∅").slice(0, 200))),
  );

  // The history page must show the same for a job that settled in this session —
  // reached by CLIENT-SIDE nav, so the module-level index cache is reused.
  let sawHistory = false;
  try {
    const histLink = aside.locator('a[href="/jobs"]').first();
    // Click through the DOM node: the sticky sidebar's icon link is not hit-testable
    // for Playwright here (an overlay covers its centre), but a real .click() still
    // dispatches the event Next's <Link> intercepts → genuine client-side nav.
    // A per-document marker: it survives a client-side nav and is recreated by a load.
    const docId = await page.evaluate(() => (window.__reproDocId ??= String(Math.random())));
    await histLink.evaluate((el) => el.click());
    await page.waitForURL("**/jobs", { timeout: 10_000 });
    const sameDoc = (await page.evaluate(() => window.__reproDocId ?? null)) === docId;
    // same-document ⇒ the module-level index cache is still the one populated before
    // the worker settled, so this assertion really is "no reload needed".
    log("after history click, url =", page.url(), "| same-document nav:", sameDoc);
    const main = page.locator("main").first();
    await waitFor(
      async () => (sawHistory = norm(await main.innerText().catch(() => "")).includes(EXPECTED)),
      { timeoutMs: SETTLE_WAIT_MS, label: `/jobs row 用时 == ${EXPECTED}` },
    );
  } catch (e) {
    log("history nav/assert failed:", String(e).slice(0, 300));
  }
  if (!sawHistory) {
    log("/jobs history after settle:", JSON.stringify(norm(await page.locator("main").first().innerText().catch(() => "")).slice(0, 400)));
  }

  // Control (dev-safe): the stubbed indexes DO carry the number, and their keys line
  // up with what the client would compute — so a fresh read yields 评估用时 12m34s and
  // the ONLY thing standing between the card and that number is the one-shot cache.
  // (A real F5 would prove the same, but `next dev` StrictMode double-invokes the
  // job-store's restore/persist pair and wipes the restored list — a dev-only artifact
  // unrelated to this bug; the post-fix run doubles as the end-to-end control.)
  const beforeControl = { ...counts };
  const control = await page.evaluate(async () => {
    const [durations, reports] = await Promise.all([
      fetch("/api/eval-durations").then((r) => r.json()),
      fetch("/api/report-status").then((r) => r.json()),
    ]);
    return { durations, reports };
  });
  const controlOk =
    control.durations?.[reportNum]?.duration === TRUE_DURATION &&
    Object.values(control.reports ?? {}).some((v) => String(v?.reportNum) === String(reportNum));
  log("index control:", controlOk ? `fresh read resolves report ${reportNum} → ${EXPECTED}` : JSON.stringify(control).slice(0, 300));
  log("request counts before control:", JSON.stringify(beforeControl));

  green = sawSidebar && sawHistory;
  console.log("\n========== VERDICT ==========");
  if (green) {
    console.log(`GREEN: both the sidebar card and the /jobs row show ${EXPECTED} (the TSV 评估用时)`);
    console.log("=> the worker surfaces re-read the timing index when a worker settles (no reload needed).");
  } else {
    console.log(
      `RED: a worker that settled in this session shows the LOCAL fallback, not the TSV 评估用时 — sidebar=${sawSidebar}, history=${sawHistory}.`,
    );
    console.log(
      "=> the index was fetched once when the card mounted and never re-read; a reload re-fetches it. " +
        `Index control (data is fetchable + joins to report ${reportNum}): ${controlOk}.`,
    );
  }
  console.log("=============================\n");
} finally {
  if (browser) await browser.close().catch(() => {});
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" });
  else dev.kill();
  // Undo `next dev`'s tsconfig include rewrite (see TSCONFIG above).
  try {
    if (fs.readFileSync(TSCONFIG, "utf8") !== tsconfigBefore) fs.writeFileSync(TSCONFIG, tsconfigBefore);
  } catch {
    /* best effort */
  }
  setTimeout(() => process.exit(green ? 0 : 1), 800);
}
