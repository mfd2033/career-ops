// Client-safe types + codec for the Explorer (job discovery). NO node imports —
// both client components and server routes import this for the shared shapes, so
// the filter contract, the discovered-offer shape, and the stream-event grammar
// can never drift between the two halves. Server-only logic (spawning the scanner,
// writing temp files) lives in lib/core/{scan,portals,pipeline}.ts.

export type AtsSource = "greenhouse" | "lever" | "ashby" | "workday";
export const ATS_SOURCES: AtsSource[] = ["greenhouse", "lever", "ashby", "workday"];
export const ATS_LABEL: Record<AtsSource, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workday: "Workday",
};

/** The Chinese boards the browser mode can search. Sources split into a plain
 *  .mjs (browser-search.mjs) so node:test can import them; re-exported here
 *  (with the literal TS type restored) so client components and server routes
 *  share ONE closed set. */
export type BrowserSource = "zhipin" | "liepin" | "zhaopin";
export const BROWSER_SOURCES: BrowserSource[] = rawBrowserSources as BrowserSource[];
export const cleanBrowserSources = ((v: unknown) => rawCleanBrowserSources(v)) as (v: unknown) => BrowserSource[];
export const parseBrowserSources = ((s: string | null | undefined) =>
  rawParseBrowserSources(s ?? undefined)) as (s: string | null | undefined) => BrowserSource[];
/** Browser-mode URL codec (serializer). Restore side: paramsToBrowser below. */
export const browserToParams = ((q: string, sources: BrowserSource[] | string[], city?: string, salaryMinK?: number) =>
  rawBrowserToParams(q, sources, city, salaryMinK)) as (
  q: string,
  sources: BrowserSource[] | string[],
  city?: string,
  salaryMinK?: number,
) => string;
export const BROWSER_LABEL: Record<BrowserSource, string> = {
  zhipin: "BOSS直聘",
  liepin: "猎聘",
  zhaopin: "智联招聘",
};

/** The full UI filter state. The keyword/location lists mirror scan.mjs's
 *  buildTitleFilter / buildLocationFilter semantics; sinceDays/ats/limitPerAts map
 *  to scan-ats-full.mjs's --since / --ats / --limit. The browser-mode fields are
 *  OPTIONAL: the deterministic scan and AI search ignore them entirely. */
export type ExploreFilters = {
  positive: string[];
  negative: string[];
  allow: string[];
  block: string[];
  blockHard: string[];
  alwaysAllow: string[];
  sinceDays: number;
  ats: AtsSource[];
  limitPerAts: number;
  // ── browser mode (Chinese boards via bsk) — scan/ai ignore these ──
  /** which surface produced this filter set; absent = scan */
  mode?: ExploreMode;
  /** platform selection for the browser hunt (default: all) */
  browserSources?: BrowserSource[];
  /** Chinese keyword for the browser hunt ("AI 工程师") */
  zhQuery?: string;
  /** Optional logical Chinese city to filter the browser hunt by (e.g. "郑州").
   *  Only the three browser boards honor it. Three states (ADR-0029 决议 6):
   *  empty = unset, fall back to `zhCityPreference`; `ZH_CITY_ANY` (全国) = a
   *  deliberate national hunt; any other value = that city for THIS hunt. */
  zhCity?: string;
  /** The long-term city preference an UNSET hunt falls back to, resolved once by
   *  seedExploreFilters (profile.yml `location.city`, else portals.yml
   *  `location_filter.allow`[0]). Kept separate from `zhCity` so "my standing
   *  preference" and "what I picked this time" never become the same field — and
   *  deliberately NOT read off `location_filter.allow`, which is serialized into
   *  the ephemeral portals.yml the CLI scanner runs against. */
  zhCityPreference?: string;
  /** 薪资下限（月薪 K，如 20 = ≥20K/月）。区间重叠判定；0/缺省 = 不过滤。
   *  无薪资文本或解析失败的岗位放行并打「薪资未知」。 */
  zhSalaryMin?: number;
};

export const DEFAULT_FILTERS: ExploreFilters = {
  positive: [],
  negative: [],
  allow: [],
  block: [],
  blockHard: [],
  alwaysAllow: [],
  sinceDays: 7,
  ats: [...ATS_SOURCES],
  limitPerAts: 150,
  browserSources: [...BROWSER_SOURCES],
  zhQuery: "",
  zhCity: "",
  zhCityPreference: "",
};

export type DiscoveredOffer = {
  url: string;
  company: string;
  title: string;
  location: string;
  /** YYYY-MM-DD, or "" when the engine reported n/a (AI offers always "") */
  postedAt: string;
  ats: string;
  source: string;
  /** which positive keyword matched the title (transparency, e.g. "ai" in "Nail") */
  matchedKeyword?: string;
  /** optional free-text ranking signal preserved to pipeline.md by the canonical
   *  writer (scan.mjs formatPipelineOffer). Generic and source-agnostic — an
   *  importer can attach a note; the deterministic scan omits it. */
  note?: string;
  /** Set on a title-gate reject only (ADR-0029 决议 4): the negative entries the
   *  title hit (an entry is a veto, so several can apply), or the fact that
   *  nothing in `positive` matched it. Produced by the gate's own compiled filter
   *  — the rules card names those words to the user, and a panel that named the
   *  wrong one on its own reading of the rule would be indistinguishable from the
   *  gate being broken (gate-visibility 工单 03). */
  gateReason?: { type: "negative" | "no-positive"; words: string[] };
  // ── browser-mode salary additions (工单 03；scan/ai offers omit both) ──
  /** raw salary display text from the listing card (e.g. "20-35K·14薪").
   *  Empty/absent = the card carried no salary the collector could read. */
  salaryText?: string;
  /** set ONLY when a salary floor gate was active and this offer's salary text
   *  yielded no monthly value (无薪资/元/天/乱文本) → 「薪资未知」打标放行. */
  salaryUnknown?: true;
  // ── AI-search (modes/discover.md) additions — all optional, so the
  //    deterministic scan offer is unaffected (fields simply absent). ──
  /** present ONLY on AI offers → drives the "unverified" badge. AI finds can't be
   *  liveness-confirmed (AGENTS.md); the scan hits a live ATS API so it omits this. */
  verification?: "unconfirmed";
  /** one-line "why it matched" judgment (the thing a deterministic scan can't give) */
  why?: string;
  /** human freshness ("~5d ago", "unknown") shown when postedAt is "" */
  postedHint?: string;
  confidence?: "low" | "medium" | "high";
};

/** The three discovery surfaces: free deterministic Scan, token-spending AI
 *  search, and the browser-mode hunt over Chinese boards (free; needs bsk). */
export type ExploreMode = "scan" | "ai" | "browser";

/** Stream event grammar (NDJSON). `kind` discriminates. Discovery is FREE — the
 *  terminal `done` always carries cost {tokens:0, usd:0}. */
export type ScanEvent =
  | { kind: "start"; ats: string[]; sinceDays: number; limit: number; free: true }
  | { kind: "atsStart"; ats: string; companies: number }
  | { kind: "progress"; ats: string; scanned: number; total: number; matches: number }
  | { kind: "atsDone"; ats: string; unreachable: number }
  | { kind: "offer"; offer: DiscoveredOffer }
  // 被采集门毙掉的岗位（ADR-0029 决议 4）。它们不进结果区，但必须到页面来：台账
  // 要写一行 status=skipped_title，结果区的「已过滤」折叠区要展示它们。只有服务端
  // 的 browser 路径会发——扩展路径的 dropped 是页面侧自己算出来的，无需回传。
  | { kind: "folded"; offers: DiscoveredOffer[] }
  | {
      kind: "summary";
      companiesScanned: number;
      unreachable: number;
      matches: number;
      // Authoritative degraded-vs-empty signals from the scanner's --json mode (#1199).
      // Absent on older local checkouts (the legacy human-stdout parse can't supply them).
      companiesAvailable?: number;
      capHit?: boolean;
      datasetStatus?: Record<string, "ok" | "stale" | "empty">;
      postingsDroppedNoDate?: number;
    }
  | { kind: "log"; line: string }
  | { kind: "error"; message: string }
  | { kind: "done"; count: number; offers: DiscoveredOffer[]; cost?: { tokens: number; usd: number } };

// cleanChips is defined in clean-chips.mjs (plain JS) so it can be shared
// with the test suite without a TypeScript runner. Import for internal use
// and re-export for external consumers (filter-builder.tsx, etc.).
import { cleanChips } from "./clean-chips.mjs";
export { cleanChips };
import {
  BROWSER_SOURCES as rawBrowserSources,
  cleanBrowserSources as rawCleanBrowserSources,
  parseBrowserSources as rawParseBrowserSources,
  browserToParams as rawBrowserToParams,
} from "./browser-search.mjs";
// 采集门（ADR-0029）与薪资判定的客户端再导出：探索页扩展路径在 scan-offers 取回处
// 套用与服务端 browser-scan **逐字相同**的门组合（薪资门 → 城市门），两道都是
// browser-search.mjs 的纯函数——两条 driver 的 keep/drop 因此由同一段代码保证，而不是
// 靠两处各自正确。卡片侧用 isSalaryUnknown 决定「薪资未知」打标。
// matchesBrowserSalary / matchesBrowserCity 是两道门的单元级形态，只剩
// browser-search.mjs 内部与单测的调用方，不经此处。
export { isSalaryUnknown, applyBrowserSalaryGate, applyBrowserCityGate, applyBrowserTitleGate, effectiveBrowserCity, ZH_CITY_ANY } from "./browser-search.mjs";

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function cleanAts(v: unknown): AtsSource[] {
  if (!Array.isArray(v)) return [...ATS_SOURCES];
  const out = v
    .map((a) => String(a).toLowerCase())
    .filter((a): a is AtsSource => (ATS_SOURCES as string[]).includes(a));
  return out.length ? Array.from(new Set(out)) : [...ATS_SOURCES];
}

/** Apply a (possibly partial) action/assistant patch onto a base. The assistant
 *  emits {positive,negative,allow,block,alwaysAllow,since,ats,limit}. With
 *  merge=true, list fields are ADDED to the base; otherwise the given fields
 *  REPLACE. Unspecified fields are left as-is. */
export function parseExplorePatch(
  raw: Record<string, unknown>,
  base: ExploreFilters = DEFAULT_FILTERS,
  merge = false,
): ExploreFilters {
  const next: ExploreFilters = { ...base, ats: [...base.ats] };
  const lists: [keyof ExploreFilters, string][] = [
    ["positive", "positive"],
    ["negative", "negative"],
    ["allow", "allow"],
    ["block", "block"],
    ["blockHard", "blockHard"],
    ["alwaysAllow", "alwaysAllow"],
  ];
  for (const [field, key] of lists) {
    if (raw[key] === undefined) continue;
    const incoming = cleanChips(raw[key]);
    next[field] = (merge ? cleanChips([...(base[field] as string[]), ...incoming]) : incoming) as never;
  }
  if (raw.since !== undefined) next.sinceDays = clampNum(raw.since, 1, 60, base.sinceDays);
  if (raw.sinceDays !== undefined) next.sinceDays = clampNum(raw.sinceDays, 1, 60, base.sinceDays);
  if (raw.limit !== undefined) next.limitPerAts = clampNum(raw.limit, 50, 500, base.limitPerAts);
  if (raw.limitPerAts !== undefined) next.limitPerAts = clampNum(raw.limitPerAts, 50, 500, base.limitPerAts);
  if (raw.ats !== undefined) next.ats = cleanAts(raw.ats);
  // ── browser mode additions (optional; the deterministic scan ignores them) ──
  if (raw.mode !== undefined) {
    const m = String(raw.mode).toLowerCase();
    next.mode = m === "scan" || m === "ai" || m === "browser" ? m : base.mode;
  }
  if (raw.browserSources !== undefined) {
    next.browserSources = cleanBrowserSources(raw.browserSources) as BrowserSource[];
  }
  if (raw.zhQuery !== undefined) next.zhQuery = String(raw.zhQuery).slice(0, 200);
  if (raw.zhCity !== undefined) next.zhCity = String(raw.zhCity).trim().slice(0, 50);
  if (raw.zhSalaryMin !== undefined) {
    const n = Number(raw.zhSalaryMin);
    // 正数保留（1 位小数封顶）；0/负数/非数字 = 清除条件。
    next.zhSalaryMin = Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : undefined;
  }
  return next;
}

/** URL <-> filters codec (so a search is shareable/restorable). */
export function filtersToParams(f: ExploreFilters): string {
  const sp = new URLSearchParams();
  if (f.positive.length) sp.set("q", f.positive.join(","));
  if (f.negative.length) sp.set("not", f.negative.join(","));
  if (f.allow.length) sp.set("loc", f.allow.join(","));
  if (f.block.length) sp.set("noloc", f.block.join(","));
  if (f.blockHard.length) sp.set("hardno", f.blockHard.join(","));
  if (f.alwaysAllow.length) sp.set("home", f.alwaysAllow.join(","));
  if (f.sinceDays !== DEFAULT_FILTERS.sinceDays) sp.set("since", String(f.sinceDays));
  if (f.ats.length !== ATS_SOURCES.length) sp.set("ats", f.ats.join(","));
  if (f.limitPerAts !== DEFAULT_FILTERS.limitPerAts) sp.set("limit", String(f.limitPerAts));
  return sp.toString();
}

export function paramsToFilters(sp: URLSearchParams, base: ExploreFilters = DEFAULT_FILTERS): ExploreFilters {
  const split = (s: string | null) => (s ? s.split(",") : undefined);
  return parseExplorePatch(
    {
      positive: split(sp.get("q")),
      negative: split(sp.get("not")),
      allow: split(sp.get("loc")),
      block: split(sp.get("noloc")),
      blockHard: split(sp.get("hardno")),
      alwaysAllow: split(sp.get("home")),
      since: sp.get("since") ?? undefined,
      ats: split(sp.get("ats")),
      limit: sp.get("limit") ?? undefined,
    },
    base,
  );
}

/** AI-search URL codec (so an AI hunt is shareable/restorable). */
export function aiToParams(intent: string): string {
  const sp = new URLSearchParams();
  sp.set("mode", "ai");
  if (intent.trim()) sp.set("intent", intent.trim());
  return sp.toString();
}

export function paramsToAi(sp: URLSearchParams): string | null {
  if (sp.get("mode") !== "ai") return null;
  return sp.get("intent") ?? "";
}

/** Browser-mode URL codec restore. Mirrors paramsToAi: null unless the URL is a
 *  browser hunt, in which case the filter patch is rebuilt (unknown/absent
 *  sources fall back to the default set). Serializer: browserToParams (browser-search.mjs). */
export function paramsToBrowser(sp: URLSearchParams, base: ExploreFilters = DEFAULT_FILTERS): ExploreFilters | null {
  if (sp.get("mode") !== "browser") return null;
  const parsed = parseBrowserSources(sp.get("sources") ?? undefined);
  const smin = Number(sp.get("smin"));
  return {
    ...base,
    browserSources: parsed.length ? (parsed as BrowserSource[]) : [...BROWSER_SOURCES],
    zhQuery: sp.get("zh") ?? "",
    zhCity: (sp.get("city") ?? "").trim(),
    zhSalaryMin: Number.isFinite(smin) && smin > 0 ? smin : undefined,
    mode: "browser",
  };
}

/** Is the search broad enough that "nothing found" means "you're current"
 *  (good news) rather than "loosen your filters" (actionable)? */
export function isBroadSearch(f: ExploreFilters): boolean {
  return f.positive.length <= 1 && f.block.length === 0 && f.allow.length === 0;
}
