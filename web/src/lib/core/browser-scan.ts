import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { cleanBrowserSources, expandSearchTargets, applyBrowserCityGate, applyBrowserSalaryGate, applyBrowserTitleGate, effectiveBrowserCity, cleanSalaryText } from "../browser-search.mjs";
import { type BrowserSource, type DiscoveredOffer, type ExploreFilters, type ScanEvent } from "@/lib/explore";

export type { DiscoveredOffer, ScanEvent } from "@/lib/explore";

/**
 * Browser-mode discovery — walks the Chinese boards (BOSS直聘/猎聘/智联招聘)
 * through the USER'S OWN logged-in browser via `bsk-extract.mjs --mode listing`
 * (browser-skill / `bsk` CLI). Those boards wall headless and logged-out
 * browsers; using the real browser session keeps a live login, so the fallback
 * path never regresses to a logged-out Playwright profile (which the three
 * boards all refuse). This is the designated Playwright-free fallback when the
 * extension driver is not connected (ADR-0007 E6): extension takes priority,
 * bsk fallback preserves login, and ATS HTTP scanning stays untouched.
 *
 * DISCOVERY STAYS FREE — zero LLM tokens; the collector only drives a browser.
 *
 * Run is SEQUENTIAL (one browser session at a time — bsk drives the shared real
 * browser and a platform failure counts as unreachable, the hunt continues).
 */
export const BROWSER_PROFILE_DIR = path.join(careerOpsRoot(), ".cache", "job-profile");

// bsk 是唯一的运行前提（真实浏览器驱动自带登录态）。保留 BROWSER_PROFILE_DIR 导出以防
// 其他调用方引用；本路径已不创建独立 profile。
const BSK_EXE = "bsk";

/** Probe once whether the bsk collector can run (`bsk` CLI on PATH + browser-skill
 *  extension connected). Called by the route BEFORE any stream so a missing
 *  capability fails as a structured 400 (browserCollectorMissing), never as a
 *  mid-stream runtime error. Depends only on bsk — no Playwright, no Edge path. */
export function browserCollectorReady(): boolean {
  try {
    if (!fs.existsSync(rootScript("bsk-extract"))) return false;
    const r = spawnSync(BSK_EXE, ["status"], { windowsHide: true, timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

type BskJob = { title?: string; url?: string; city?: string; salary?: string; salaryUnknown?: boolean };
type BskListing = { url?: string; jobs?: BskJob[] };

export function runBrowserDiscovery(
  filters: ExploreFilters,
  onEvent: (e: ScanEvent) => void,
): Promise<DiscoveredOffer[]> {
  return new Promise((resolve) => {
    const sources = cleanBrowserSources(filters.browserSources as unknown as BrowserSource[] | undefined) as BrowserSource[];
    // 用户在关键词框用空格分隔多个职位候选（便于手动编辑）。实际搜索时按 CLI query
    // 语义把连续空白替换成 OR，使各平台按"多候选职位"处理，而不是把整串当作单个 AND 短语。
    const query = (filters.zhQuery ?? "").trim().replace(/\s+/g, " OR ");
    // 城市条件由 effectiveBrowserCity 解析（ADR-0029 决议 6）：显式选择 → 覆盖偏好；
    // 「全国」哨兵 → 门关闭；未设置 → 回落 zhCityPreference。解析值同时驱动搜索 URL 与
    // 城市门，两者才会说同一件事（否则会「全国搜、按郑州筛」）。
    const city = effectiveBrowserCity(filters);
    // 采集目标成对展开：猎聘搜索框不支持 OR 分隔的多关键词（只认单关键词），逐词
    // 拆成多条搜索 URL，每词一个采集会话；BOSS/智联整串一条。避免 buildSearchUrls
    // 的 source↔url 齐序被拆词破坏。
    const targets = expandSearchTargets(sources, query, city);
    const urls = targets.map((t) => t.url);

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
      const platform = targets[idx].source as BrowserSource;
      idx += 1;

      onEvent({ kind: "atsStart", ats: platform, companies: 0 });
      const child = spawn(
        process.execPath,
        [rootScript("bsk-extract"), url, "--mode", "listing", "--max", "200"],
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
          onEvent({
            kind: "error",
            message: `browser collection failed for ${platform} (code ${code})${structuredErr?.error ? `: ${structuredErr.error}` : ""}`,
          });
          runNext();
          return;
        }
        try {
          const parsed = JSON.parse(out) as BskListing;
          // 采集门（ADR-0029）：与扩展路径逐字相同的组合——薪资门 → 城市门 → 标题门，
          // 三道都是 browser-search.mjs 的纯函数，过滤在循环前列表级完成。两条 driver 的
          // keep/drop 由这条共享组合保证一致；任一侧漏接一道门，真实扫描里就表现为两路
          // 结果不同。
          // 薪酬门（工单 03）：区间重叠判定（上限 ≥ zhSalaryMin），无薪资/解析失败放行并
          // 打「薪资未知」标记，与 salary_filter「不误删」一致。站点口径必须显式传入：bsk
          // 列表行只有 `{title,url,city,salary}`，不带 source，而薪资口径逐站不同（猎聘裸
          // 「万」是年薪，工单 01）。这里正在采的 platform 就是答案——漏传会把 20-35万 当
          // 智联的月薪口径算成 200-350K，猎聘的薪资下限静默失效。
          // 城市门（ADR-0029 决议 7）：Q2 zero-tolerance——请求了城市就必须命中，绝不因
          // 搜索 URL 带了城市参数就信任它（智联的列表并非严格过滤；其 positionList 的城市
          // 字段权威，猎聘/BOSS 回退 title）。
          // 标题门（ADR-0029 决议 1/2）：词表是 portals.yml 的 title_filter，由探索页的
          // seedExploreFilters 播种进 ExploreFilters——这里刻意**不**回读 portals.yml：
          // 页面态与门控共用一份词表，两路才可能给出同一判定。
          //
          // 行校验刻意排在标题门之前：这样 dropped 里只会有「本可以进结果区、单被标题门
          // 毙掉」的岗位，台账那行 skipped_title 才名副其实（URL/title 残缺的行不该被记成
          // 「被关键词过滤」）。
          const raw = Array.isArray(parsed.jobs) ? parsed.jobs : [];
          const usable = raw.filter(
            (j) => /^https?:\/\//i.test(String(j.url ?? "").trim()) && String(j.title ?? "").trim().length >= 3,
          );
          const { kept, dropped } = applyBrowserTitleGate(
            applyBrowserCityGate(applyBrowserSalaryGate(usable, filters.zhSalaryMin, platform), city),
            { positive: filters.positive, negative: filters.negative },
          );
          // 清洗字形反爬 PUA（智联 positionList 薪资字段同样可能携带）；清洗后无数字
          // （如只剩 "-K"）则不带 salaryText，走「薪资未知」打标。
          const toOffer = (j: BskJob): DiscoveredOffer => {
            const cleanedSalary = cleanSalaryText(j.salary);
            const salaryText = cleanedSalary && /\d/.test(cleanedSalary) ? cleanedSalary : "";
            return {
              url: String(j.url ?? "").trim(),
              company: "",
              title: String(j.title ?? "").trim(),
              location: "",
              postedAt: "",
              ats: "browser",
              source: `browser-${platform}`,
              note: city ? `browser · ${platform} · ${city}` : `browser · ${platform}`,
              ...(salaryText ? { salaryText } : {}),
              ...(j.salaryUnknown ? { salaryUnknown: true as const } : {}),
            };
          };
          for (const j of kept) {
            const offer = toOffer(j);
            if (seen.has(offer.url)) continue;
            seen.add(offer.url);
            offers.push(offer);
            onEvent({ kind: "offer", offer });
          }
          // 被标题门毙掉的岗位也要送到页面：台账要写一行 skipped_title，结果区的
          // 「已过滤」折叠区要展示它们（ADR-0029 决议 4）。它们**不进 offers** —— 采集
          // 落地门的定义就是「不进结果区」，这是刻意的。
          if (dropped.length > 0) onEvent({ kind: "folded", offers: dropped.map(toOffer) });
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
