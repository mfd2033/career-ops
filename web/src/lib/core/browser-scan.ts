import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { buildSearchUrls, cleanBrowserSources, matchesBrowserCity } from "../browser-search.mjs";
import { type BrowserSource, type DiscoveredOffer, type ExploreFilters, type ScanEvent } from "@/lib/explore";

export type { DiscoveredOffer, ScanEvent } from "@/lib/explore";

/**
 * Browser-mode discovery — walks the Chinese boards (BOSS直聘/猎聘/智联招聘)
 * through an INDEPENDENT job-seeking Edge profile via `zh-collect.mjs`
 * (Playwright; CDP trusted `page.mouse.wheel()` for the lazy-load boards and
 * pagination for 猎聘). Those boards wall headless and logged-out browsers; the
 * independent profile keeps its own login cookies, isolated from the user's
 * daily Edge (ADR-0001). Each platform run starts with a multi-signal login
 * precheck; when not logged in the collector auto-pops the login window, waits
 * for the scan, then resumes (G8/A) — 猎聘 hard-requires login, BOSS/智联
 * degrade to a logged-out collect on login timeout.
 *
 * DISCOVERY STAYS FREE — zero LLM tokens; the collector only drives a browser.
 *
 * Run is SEQUENTIAL (one browser session at a time — sessions are per-platform
 * start/stop and the browser is a scarce shared resource); a platform failure
 * counts as unreachable and the hunt continues with the next one. ATS API
 * scanning is untouched and fully independent of this path.
 */

/** Independent job-seeking Edge profile directory (cookie-persistent). */
export const BROWSER_PROFILE_DIR = path.join(careerOpsRoot(), ".cache", "job-profile");

// System Edge install locations (msedge channel). Playwright resolves the
// channel from PATH too; these are the common fixed paths checked by the gate.
const EDGE_EXE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** Probe once whether the browser collector can run (zh-collect + Playwright +
 *  system Edge). Called by the route BEFORE any stream so a missing capability
 *  fails as a structured 400 (browserCollectorMissing), never as a mid-stream
 *  runtime error. */
export function browserCollectorReady(): boolean {
  try {
    if (!fs.existsSync(rootScript("zh-collect"))) return false;
    if (!fs.existsSync(path.join(careerOpsRoot(), "node_modules", "playwright", "package.json"))) return false;
    return EDGE_EXE_CANDIDATES.some((p) => fs.existsSync(p));
  } catch {
    return false;
  }
}

type BskListing = { url?: string; jobs?: Array<{ title?: string; url?: string; city?: string }> };

// Structured collector failures (stderr JSON { error, code }) that deserve a
// distinct user-facing hint vs a generic platform failure.
const LOGIN_HINT_CODES = new Set(["login_required", "login_timeout"]);

export function runBrowserDiscovery(
  filters: ExploreFilters,
  onEvent: (e: ScanEvent) => void,
): Promise<DiscoveredOffer[]> {
  return new Promise((resolve) => {
    const sources = cleanBrowserSources(filters.browserSources as unknown as BrowserSource[] | undefined) as BrowserSource[];
    // 用户在关键词框用空格分隔多个职位候选（便于手动编辑）。实际搜索时按 CLI query
    // 语义把连续空白替换成 OR，使各平台按"多候选职位"处理，而不是把整串当作单个 AND 短语。
    const query = (filters.zhQuery ?? "").trim().replace(/\s+/g, " OR ");
    const city = filters.zhCity?.trim() ?? "";
    const urls = buildSearchUrls(sources, query, city);

    const offers: DiscoveredOffer[] = [];
    const seen = new Set<string>();
    let unreachable = 0;

    // The engine contracts (ScanEvent grammar) are shared with the ATS scan, so
    // the client renders browser runs with the same progress surface. `companies`
    // reads as "platforms" here — a browser session per source.
    const finish = () => {
      onEvent({ kind: "summary", companiesScanned: urls.length - unreachable, unreachable, matches: offers.length });
      resolve(offers);
    };

    if (urls.length === 0) {
      finish();
      return;
    }

    // Login wait (up to 120s per platform) + collection: a real browser walk is
    // much slower than ATS HTTP, and the first run can sit on a login popup.
    const childTimeoutMs = 300_000;
    let idx = 0;

    const runNext = () => {
      if (idx >= urls.length) {
        finish();
        return;
      }
      const url = urls[idx];
      const platform = sources[idx] as BrowserSource;
      idx += 1;

      onEvent({ kind: "atsStart", ats: platform, companies: 0 });
      const child = spawn(
        process.execPath,
        [
          rootScript("zh-collect"),
          url,
          "--platform",
          platform,
          "--profile",
          BROWSER_PROFILE_DIR,
          "--max",
          "200",
          "--login-wait",
        ],
        { cwd: careerOpsRoot(), windowsHide: true },
      );

      let out = "";
      let structuredErr: { error?: string; code?: string } | null = null;
      const killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }, childTimeoutMs);

      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        const line = d.toString().trim();
        if (!line) return;
        // The collector ends failures with a structured { error, code } line —
        // surface it via the error event (not the log stream) later.
        try {
          const parsed = JSON.parse(line) as { log?: string; error?: string; code?: string };
          if (parsed.error && parsed.code) {
            structuredErr = { error: parsed.error, code: parsed.code };
            return;
          }
        } catch {
          /* plain text */
        }
        onEvent({ kind: "log", line });
      });
      child.on("error", (e) => {
        clearTimeout(killer);
        unreachable += 1;
        onEvent({ kind: "atsDone", ats: platform, unreachable: 1 });
        onEvent({ kind: "error", message: e instanceof Error ? e.message : "zh-collect failed to start" });
        runNext();
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (code !== 0) {
          unreachable += 1;
          onEvent({ kind: "atsDone", ats: platform, unreachable: 1 });
          const hint = structuredErr?.code && LOGIN_HINT_CODES.has(structuredErr.code);
          onEvent({
            kind: "error",
            message: hint
              ? `浏览器采集 ${platform} 需要登录：${structuredErr?.error ?? "请登录后重试。"}`
              : `browser collection failed for ${platform} (code ${code})${structuredErr?.error ? `: ${structuredErr.error}` : ""}`,
          });
          runNext();
          return;
        }
        try {
          const parsed = JSON.parse(out) as BskListing;
          const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
          for (const j of jobs) {
            const link = String(j.url ?? "").trim();
            const title = String(j.title ?? "").trim();
            if (!/^https?:\/\//i.test(link) || !title || title.length < 3) continue;
            // Q2 zero-tolerance post-gate: a requested city MUST match — never
            // keep a job on trust that the search URL's city parameter filtered
            // it (智联's list is not strictly filtered; its positionList city is
            // authoritative, 猎聘/BOSS fall back to the title).
            if (!matchesBrowserCity(j, city)) continue;
            if (seen.has(link)) continue;
            seen.add(link);
            const offer: DiscoveredOffer = {
              url: link,
              company: "",
              title,
              location: "",
              postedAt: "",
              ats: "browser",
              source: `browser-${platform}`,
              note: city ? `browser · ${platform} · ${city}` : `browser · ${platform}`,
            };
            offers.push(offer);
            onEvent({ kind: "offer", offer });
          }
          onEvent({ kind: "atsDone", ats: platform, unreachable: 0 });
          runNext();
        } catch (e) {
          unreachable += 1;
          onEvent({ kind: "atsDone", ats: platform, unreachable: 1 });
          onEvent({ kind: "error", message: `Failed to parse browser output for ${platform}` });
          runNext();
        }
      });
    };

    runNext();
  });
}
