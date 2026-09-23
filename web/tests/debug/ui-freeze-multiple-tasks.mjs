// [DEBUG-harness] Regression loop for: "工作区有多个任务在进行时，点击页面其他功能没有反应"
//
// Pre-fix root cause (proven red, 2026-09): every /api/run task — running OR
// queued — held its own streaming HTTP response; HTTP/1.1 browsers cap
// same-origin sockets at 6, so ~6 concurrent tasks starved every NEW request
// and clicks on the page did nothing. Measured: fetch latency 87ms baseline /
// 19ms at 5 held streams / >15s STALLED at 6.
//
// Post-fix (ADR-0020): POST /api/run returns {runId} immediately and all
// worker events flow through ONE multiplexed /api/events connection per tab.
// This harness now asserts the fix holds:
//   1. start `next start` on :3100 (PRODUCTION build — run `npm run build`
//      in web/ first; production because turbopack dev never hydrates headless
//      here, and it matches the launcher's standalone-server form)
//   2. reverse-proxy on localhost:4100 -> 3100 (the proxy connects upstream over
//      127.0.0.1 — bind-side literal, see _custom.md localhost rule); POST /api/run with kind
//      "__hold__" is stubbed by the proxy as an immediate {runId} (transport
//      stub: simulates task starts without spawning a real CLI). The proxy
//      COUNTS currently-held forwarded connections to /api/events.
//   3. Playwright Chromium loads the app THROUGH the proxy (same origin),
//      starts 8 "tasks", and asserts:
//        a) the page holds exactly ONE long connection (/api/events) — per-task
//           streams are gone (this is the red signal: >1 held connection or a
//           forwarded /api/run that stays open means the old transport is back);
//        b) a click-equivalent fetch stays fast with 8 tasks in flight.
//
// Run: node web/tests/debug/ui-freeze-multiple-tasks.mjs

import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "..");
const DEV_PORT = 3100;
const PROXY_PORT = 4100;
// The origin the browser loads — access address, so localhost per _custom.md.
const ORIGIN = `http://localhost:${PROXY_PORT}`;
const FETCH_TIMEOUT_MS = 15_000;
const FAST_MS = 2_000; // verdict threshold: a click/fetch slower than this = stalled
const N_TASKS = 8; // > 6: would saturate the old per-task-stream transport

const log = (...a) => console.log("[repro]", ...a);

// --- 1. dev server ----------------------------------------------------------
const dev = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(DEV_PORT)], {
  cwd: WEB_DIR,
  stdio: ["ignore", "pipe", "pipe"],
});
dev.stdout.on("data", (d) => process.env.REPRO_VERBOSE && process.stdout.write("[next] " + d));
dev.stderr.on("data", (d) => process.env.REPRO_VERBOSE && process.stderr.write("[next!] " + d));

async function waitReady(url, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`dev server not ready after ${timeoutMs}ms`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// --- 2. proxy ----------------------------------------------------------------
const held = { events: 0, runStreams: 0 }; // currently-open long connections by path

function startProxy() {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/run") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let kind = "";
        try { kind = JSON.parse(body).kind || ""; } catch { /* ignore */ }
        if (kind === "__hold__") {
          // ADR-0020 stub: a task start is an immediate {runId} — NO held stream.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ runId: "stub-" + Math.random().toString(36).slice(2) }));
          return;
        }
        forward(req, res, body);
      });
      return;
    }
    forward(req, res, null);
  });

  function forward(req, res, bufferedBody) {
    const isEvents = req.url === "/api/events";
    const isRun = req.url === "/api/run";
    if (process.env.REPRO_VERBOSE) log("fwd", req.method, req.url);
    if (isEvents) held.events++;
    if (isRun) held.runStreams++;
    const opts = { hostname: "127.0.0.1", port: DEV_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${DEV_PORT}` } };
    const up = http.request(opts, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    const done = () => { if (isEvents) held.events--; if (isRun) held.runStreams--; };
    up.on("error", () => { done(); try { res.writeHead(502); res.end(); } catch { /* */ } });
    res.on("close", done);
    if (bufferedBody != null) up.end(bufferedBody);
    else req.pipe(up);
  }

  return new Promise((resolve) => server.listen(PROXY_PORT, "127.0.0.1", () => resolve(server)));
}

// --- 3. page helpers -----------------------------------------------------------
async function timeFetch(page, path) {
  return page.evaluate(async ({ path, timeout }) => {
    const t0 = performance.now();
    try {
      const r = await Promise.race([
        fetch(path, { cache: "no-store" }).then((r) => r.text()),
        new Promise((_, rej) => setTimeout(() => rej(new Error("fetch stalled")), timeout)),
      ]);
      return { ms: performance.now() - t0, stalled: false };
    } catch (e) {
      return { ms: performance.now() - t0, stalled: true, err: String(e) };
    }
  }, { path, timeout: FETCH_TIMEOUT_MS });
}

async function startTasks(page, n) {
  // Fire n task starts (stubbed by the proxy). Post-fix these return {runId}
  // immediately and consume NO connection budget.
  await page.evaluate(async (n) => {
    window.__reproTasks = [];
    for (let i = 0; i < n; i++) {
      window.__reproTasks.push(
        fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "__hold__", input: "hold-" + i, cliId: "claude" }),
          cache: "no-store",
        }).then((r) => r.json()).catch(() => {}),
      );
    }
    await Promise.all(window.__reproTasks);
  }, n);
}

// --- main ---------------------------------------------------------------------
try {
  log("waiting for dev server on :" + DEV_PORT + " (cold compile can take a while)…");
  await waitReady(`http://localhost:${DEV_PORT}/api/version`, 240_000);
  await startProxy();
  log("proxy ready on :" + PROXY_PORT);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") log("page-console-error:", m.text().slice(0, 300)); });
  page.on("pageerror", (e) => log("page-error:", String(e).slice(0, 300)));
  await page.goto(ORIGIN + "/", { waitUntil: "load", timeout: 180_000 });
  await page.waitForTimeout(2000); // let the job-store open its /api/events channel

  // baseline click-equivalent latency, with no tasks
  const baseFetch = await timeFetch(page, "/api/active-runs");
  log(`BASELINE  fetch=${baseFetch.ms.toFixed(0)}ms${baseFetch.stalled ? " STALLED" : ""}  heldEvents=${held.events}`);

  // 8 tasks in flight
  await startTasks(page, N_TASKS);
  await page.waitForTimeout(1000);
  const taskFetch = await timeFetch(page, "/api/active-runs");
  log(`TASKS=${N_TASKS}  fetch=${taskFetch.ms.toFixed(0)}ms${taskFetch.stalled ? " STALLED" : ""}  heldEvents=${held.events}  heldRunStreams=${held.runStreams}`);

  console.log("\n========== VERDICT ==========");
  const fetchFast = !baseFetch.stalled && baseFetch.ms < FAST_MS && !taskFetch.stalled && taskFetch.ms < FAST_MS;
  const oneChannel = held.events === 1 && held.runStreams === 0;
  if (fetchFast && oneChannel) {
    console.log(`GREEN: with ${N_TASKS} tasks in flight the page holds exactly ONE connection (/api/events) and clicks stay fast (<${FAST_MS}ms).`);
    console.log("=> ADR-0020 fix holds: tasks no longer consume the HTTP/1.1 connection budget.");
  } else {
    console.log("RED: regression — " +
      (!fetchFast ? `click-equivalent fetch stalled (${taskFetch.ms.toFixed(0)}ms); ` : "") +
      (!oneChannel ? `connection topology wrong (heldEvents=${held.events}, heldRunStreams=${held.runStreams}, expect 1 and 0).` : ""));
    console.log("=> Per-task streaming responses are back, or the channel is not single. Check /api/run + job-store transport.");
  }
  console.log("=============================\n");

  await browser.close();
} finally {
  dev.kill();
  setTimeout(() => process.exit(0), 500);
}
