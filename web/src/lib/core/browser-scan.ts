import { spawn, spawnSync } from "node:child_process";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { buildSearchUrls, cleanBrowserSources, matchesBrowserCity } from "../browser-search.mjs";
import { type BrowserSource, type DiscoveredOffer, type ExploreFilters, type ScanEvent } from "@/lib/explore";

export type { DiscoveredOffer, ScanEvent } from "@/lib/explore";

/**
 * Browser-mode discovery — walks the Chinese boards (BOSS直聘/猎聘/智联招聘)
 * through the user's OWN logged-in browser via `bsk-extract.mjs --mode listing`
 * (those boards wall headless and logged-out browsers; the user's real session
 * with its cookies is the only reliable path, and a manual captcha solve is
 * handed to the user by browser-skill itself).
 *
 * DISCOVERY STAYS FREE — zero LLM tokens; bsk only drives the user's browser.
 *
 * Run is SEQUENTIAL (one browser session at a time — sessions are per-platform
 * start/stop and the browser is a scarce shared resource); a platform failure
 * counts as unreachable and the hunt continues with the next one.
 */

/** Probe once whether the bsk CLI exists and its daemon answers. Called by the
 *  route BEFORE any stream so a missing bsk fails as BSK_MISSING (structured
 *  400), never as a mid-stream runtime error. */
export function bskInstalled(): boolean {
  try {
    const probe = spawnSync("bsk", ["status"], {
      cwd: careerOpsRoot(),
      timeout: 8_000,
      windowsHide: true,
    });
    return probe.status === 0;
  } catch {
    return false; // ENOENT — not on PATH
  }
}

type BskListing = { url?: string; jobs?: Array<{ title?: string; url?: string; city?: string }> };

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

    const childTimeoutMs = 90_000; // browser extraction is slower than ATS HTTP
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
        [rootScript("bsk-extract"), url, "--mode", "listing", "--max", "200"],
        { cwd: careerOpsRoot(), windowsHide: true },
      );

      let out = "";
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
        if (line) onEvent({ kind: "log", line });
      });
      child.on("error", (e) => {
        clearTimeout(killer);
        unreachable += 1;
        onEvent({ kind: "atsDone", ats: platform, unreachable: 1 });
        onEvent({ kind: "error", message: e instanceof Error ? e.message : "bsk-extract failed to start" });
        runNext();
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (code !== 0) {
          unreachable += 1;
          onEvent({ kind: "atsDone", ats: platform, unreachable: 1 });
          onEvent({ kind: "error", message: `browser extraction failed for ${platform} (code ${code})` });
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