// [DEBUG-a4f2] Verification loop for ticket 02 / ADR-0036 decision 4:
//   「状态写入失败必须可见」—— 下拉框回滚时要说明原因，不能静默。
//
// ZERO WRITES: POST /api/status is stubbed, so this never touches the tracker.
//   Case 1: 409 { code: "ambiguous" }  → alert with the dedup-tracker.mjs fix,
//           select reverted, no 已保存 flash
//   Case 2: 200 { ok: true }           → value kept, no alert
//
// Also drops a header screenshot so the layout of the error line can be eyeballed.
//
// Run: node web/tests/debug/status-write-error-visible.mjs   (PORT=3100)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(WEB_DIR, "..");
const PORT = Number(process.env.PORT ?? 3000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SHOT = path.join(REPO_DIR, ".scratch", "status-error-header.png");
const TAG = "[DEBUG-a4f2]";
const log = (...a) => console.log(TAG, ...a);

const MODE = { stub: "ambiguous" }; // flipped between cases below

const pipeline = await (await fetch(`${ORIGIN}/api/pipeline`)).json();
const rows = pipeline.applications ?? [];
// Any row renders the control; ROW only pins which one, so the tracker stays
// out of this file (its contents are the user's private job-search data).
const ROW = String(process.env.ROW ?? rows[0]?.n ?? "");
const row = rows.find((r) => String(r.n) === ROW);
if (!row) throw new Error(`row #${ROW} not in the tracker`);
log(`row #${ROW} status=${JSON.stringify(row.status)}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("career-ops:lang", "zh");
  localStorage.setItem("career-ops:default-lang", "zh");
});

// Stub ONLY the writeback.
await page.route("**/api/status", (route) => {
  if (route.request().method() !== "POST") return route.continue();
  if (MODE.stub === "ambiguous") {
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "#432 is a duplicate tracker number shared by 2 rows — pass --role …", code: "ambiguous" }),
    });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, changed: true, statusLogged: true }) });
});

let green = false;
try {
  await page.goto(`${ORIGIN}/pipeline/${ROW}`, { waitUntil: "load", timeout: 180_000 });
  const select = page.locator("select").first();
  await select.waitFor({ state: "visible", timeout: 60_000 });

  // Scoped to the status control (the only <select> inside a <span> in this
  // header) — the page may carry other role="alert" nodes of its own.
  const alert = page.locator('xpath=//span[select]//span[@role="alert"]');
  log(
    "pre-existing role=alert nodes:",
    JSON.stringify(await page.locator('[role="alert"]').evaluateAll((els) => els.map((e) => String(e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)))),
  );
  const before = await select.inputValue();
  const target = before === "Applied" ? "Rejected" : "Applied";

  // --- case 1: the write fails ---------------------------------------------
  await select.selectOption(target);
  await alert.first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(600);
  const alertCount = await alert.count();
  const alertText = alertCount ? (await alert.first().innerText()).replace(/\s+/g, " ").trim() : "";
  const after = await select.inputValue();
  const reverted = after === before;
  const namesFix = /dedup-tracker\.mjs/.test(alertText);
  const noSavedFlag = !/已保存|saved/i.test(alertText);
  log(`case 1 (409 ambiguous): alerts=${alertCount}, select ${JSON.stringify(before)}→${JSON.stringify(after)} (reverted: ${reverted})`);
  log(`  alert text: ${JSON.stringify(alertText)}`);
  log(`  names the repair command: ${namesFix} | no saved-flag in the alert: ${noSavedFlag}`);

  // Viewport shot (not element-level: the header's animated logo never reaches
  // the "stable" state an element screenshot waits for).
  await page.screenshot({ path: SHOT, animations: "disabled" }).catch((e) => log("screenshot failed:", String(e).slice(0, 120)));
  log(`screenshot: ${SHOT}`);

  // --- case 2: the write succeeds ------------------------------------------
  MODE.stub = "ok";
  await select.selectOption(target);
  await page.waitForTimeout(1200);
  const okValue = await select.inputValue();
  const okAlerts = await alert.count();
  const kept = okValue === target;
  log(`case 2 (200 ok): select=${JSON.stringify(okValue)} kept=${kept}, alerts=${okAlerts}`);

  green = reverted && namesFix && noSavedFlag && kept && okAlerts === 0;
  console.log("\n========== VERDICT ==========");
  if (green) {
    console.log("GREEN: a failed status write reverts AND explains itself (with the repair command); a successful one is untouched");
  } else {
    console.log("RED: the dropdown still fails without telling the user why (or the success path regressed).");
    console.log(`  reverted=${reverted} namesFix=${namesFix} noSavedFlag=${noSavedFlag} successKept=${kept} alertsAfterSuccess=${okAlerts}`);
    console.log(`  alert text seen: ${JSON.stringify(alertText)}`);
  }
  console.log("=============================\n");
} finally {
  await browser.close().catch(() => {});
  setTimeout(() => process.exit(green ? 0 : 1), 300);
}
