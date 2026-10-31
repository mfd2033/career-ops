// Results-view derivations: which rows are ON SCREEN, and which of those can be
// confirmed into the pipeline.
//
// Why this is a module and not two memos in the component: the results area
// derives BOTH sets from the same offer list, and it used to derive them
// separately — the rendered rows came from the tab+keyword filtered list, while
// the 「全选可加入 (N)」 count came from the whole result set. Type a keyword and
// the two disagree: the button promised N rows, three were on screen, and
// clicking it confirmed rows the user could not see. One derivation means the
// number on the button, the boxes it ticks, and the rows it confirms are the
// same set by construction, not by two memos happening to agree.
//
// The tab vocabulary is owned by results-list.tsx (`ResultTab`/`TABS`); these
// helpers only read it.

import { matchesReportNo } from "./report-no-search.mjs";
import { normalizeUrl } from "./core/url-key.mjs";
import { parseSalaryText } from "./browser-search.mjs";

/**
 * Which result tab an enriched offer belongs to.
 *
 * @param {{inPipeline?: boolean, evaluatedN?: string}} o
 * @returns {"all" | "new" | "pipeline" | "evaluated"}
 */
export function resultTabOf(o) {
  return o.evaluatedN ? "evaluated" : o.inPipeline ? "pipeline" : "new";
}

/**
 * Is this offer inside the selected tab? 「全部」 is the fallback that covers
 * every group, so the four tabs partition the result set exactly.
 *
 * @param {string} tab
 * @param {{inPipeline?: boolean, evaluatedN?: string}} o
 * @returns {boolean}
 */
export function inResultTab(tab, o) {
  return tab === "all" || resultTabOf(o) === tab;
}

/**
 * The tracker number of the row this offer was already evaluated as, or
 * undefined when it was never evaluated.
 *
 * Dimension 1 — URL (exact): the SAME canonical normalizeUrl key every other
 * surface uses (whats-new's evaluatedUrls, /api/report-status). A re-discovered
 * posting whose tracker row carries the same URL IS that posting — no fuzzy
 * matching can disagree. This dimension is load-bearing for browser boards
 * (智联/BOSS/猎聘): their scan/offer records carry `company: ""`, so the text
 * dimension below can never fire for them (584 of 736 real (tracker, scan)
 * pairs missed before this existed — the explore results badged evaluated
 * postings as fresh).
 *
 * Dimension 2 — company+role text (fallback): covers tracker rows written
 * without a URL column. The company key is the FIRST dimension here and it
 * must be a REAL key. An empty
 * key is not a wildcard: browser-board scan rows carry `company: ""` (智联/BOSS
 * 采集时公司列就是空的), and the tracker writes `?` for an unknown employer
 * (ADR-0004 的 sentinel) — and `normalizeTextKey("?")` is ALSO the empty string.
 * Both sides normalizing to "" then matched on the role overlap alone, so every
 * 「产品经理」/「项目经理」 posting from 智联/BOSS was labelled 已评估 against a
 * single unrelated `?` row. Measured on the live data: 18 of the 200 whats-new
 * offers were falsely badged (and pushed out of the default 新增 tab) by 24
 * `?` rows, while not one of those postings existed in the tracker.
 *
 * @param {{url?: string, company?: string, title?: string}} offer
 * @param {Array<{n?: string, url?: string, company?: string, role?: string}>} apps
 * @param {(s: string) => string} norm - the core's normalizeTextKey key fn
 * @returns {string|undefined} the matched tracker `#n`, or undefined
 */
export function evaluatedNoFor(offer, apps, norm) {
  return evaluatedNoFromIndex(offer, buildEvaluationIndex(apps, norm), norm);
}

/**
 * 追踪表的预归一索引：`evaluatedNoFor` 对**每一条 offer** 都重跑一遍 app 列表，
 * 每次都把全部 URL 与公司名重新归一化 —— 探索页刷新时 200 条结果 × 743 行追踪表
 * ≈ 15 万次 `new URL()`，实测占去刷新后 3s 里的一半以上 CPU。
 *
 * 归一化只取决于追踪表本身，与 offer 无关，所以按结果集算一次即可。这是同一条
 * 判定口径的预计算形式（含空键不是通配符的守卫），不是第二套规则：
 * `evaluatedNoFor` 本身就委托到这里，两个入口永不漂移。
 *
 * @param {Array<{n?: string, url?: string, company?: string, role?: string}>} apps
 * @param {(s: string) => string} norm
 * @returns {{byUrl: Map<string, string>, byCompany: Map<string, Array<{n: string, roleKey: string}>>}}
 */
export function buildEvaluationIndex(apps, norm) {
  const byUrl = new Map();
  // 公司键 → 该公司下的 [{n, roleKey}]，**保持追踪表原顺序**：原来 find 取的是
  // 第一条命中的行，改成按公司分桶后桶内顺序不变，取到的仍是同一条。
  const byCompany = new Map();
  for (const a of apps || []) {
    if (!a?.n) continue;
    const urlKey = normalizeUrl(a.url ?? "");
    if (urlKey && !byUrl.has(urlKey)) byUrl.set(urlKey, a.n);
    const c = norm(a.company ?? "");
    // 空公司键不是通配符（#2666）：公司列本身就是空的浏览器板行永远不进桶。
    if (!c) continue;
    const roleKey = norm(a.role ?? "");
    // 过短的岗位名不参与文本匹配（「项目经理」这类泛词的误配来源）。
    if (roleKey.length <= 3) continue;
    const bucket = byCompany.get(c);
    if (bucket) bucket.push({ n: a.n, roleKey });
    else byCompany.set(c, [{ n: a.n, roleKey }]);
  }
  return { byUrl, byCompany };
}

/**
 * `evaluatedNoFor` 的索引版：判定口径逐字相同，只是把追踪表那一侧换成预归一索引。
 * 结果集富化走这条（见 explorer-view 的 enriched memo）。
 *
 * @param {{url?: string, company?: string, title?: string}} offer
 * @param {ReturnType<typeof buildEvaluationIndex>} index
 * @param {(s: string) => string} norm
 * @returns {string|undefined}
 */
export function evaluatedNoFromIndex(offer, index, norm) {
  const { byUrl, byCompany } = index || {};
  // 维度 1：URL 精确匹配。空键永不互等（normalizeUrl 解析失败返回 ""，
  // 查表天然落空，不需要额外守卫）。
  const urlKey = normalizeUrl(offer.url ?? "");
  if (urlKey && byUrl) {
    const hit = byUrl.get(urlKey);
    if (hit) return hit;
  }
  // 维度 2：公司+岗位文本兜底（tracker 行没写 URL 的场景）。
  const c = norm(offer.company ?? "");
  if (!c || !byCompany) return undefined;
  const bucket = byCompany.get(c);
  if (!bucket) return undefined;
  const t = norm(offer.title ?? "");
  const head = t.split(" ").slice(0, 3).join(" ");
  const hit = bucket.find((a) => t.includes(a.roleKey) || a.roleKey.includes(head));
  return hit?.n;
}

/**
 * Is this offer confirmable into the pipeline? No if it is already there, was
 * already evaluated (that implies a pipeline row), or was confirmed earlier in
 * this session (`added` covers the window before the pipeline snapshot catches
 * up).
 *
 * @param {{url: string, inPipeline?: boolean, evaluatedN?: string}} o
 * @param {Set<string>} added - URLs confirmed into the pipeline this session.
 * @returns {boolean}
 */
export function isSelectable(o, added) {
  return !o.inPipeline && !o.evaluatedN && !added.has(o.url);
}

/**
 * Drop the offers the user explicitly dismissed from the results area.
 *
 * This is the one narrowing that is NOT the keyword/tab filter: the user pointed
 * at specific rows and said "remove these". It is display state only — nothing is
 * written to pipeline.md — and it is persisted with the result snapshot so a
 * reload keeps the dismissed rows hidden. Applying it BEFORE the tab/keyword
 * derivation keeps the tab badges and the rendered rows in agreement: a dismissed
 * row is gone from both, never counted-but-invisible.
 *
 * @param {Array<{url: string}>} offers
 * @param {Set<string>} removed - URLs dismissed by the user.
 * @returns {Array<*>} the same offer objects minus the dismissed ones, in input order.
 */
export function omitRemoved(offers, removed) {
  if (!removed || removed.size === 0) return offers;
  return offers.filter((o) => !removed.has(o.url));
}

/**
 * The rows on screen: the tab's rows, narrowed by the keyword box (title or
 * company, case-insensitive, and — when the query is a bare number — by the
 * report number of an already-evaluated offer). Order is NOT applied here —
 * sorting is presentation, and the header/tab counts deliberately look at the
 * whole result set rather than the filtered list.
 *
 * @param {Array<{url: string, title: string, company: string, inPipeline?: boolean, evaluatedN?: string}>} offers
 * @param {string} tab
 * @param {string} query - raw filter-box text; "" means no narrowing.
 * @returns {Array<*>} the same offer objects, in input order.
 */
export function visibleOffers(offers, tab, query) {
  const list = offers.filter((o) => inResultTab(tab, o));
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return list;
  return list.filter(
    (o) =>
      o.title.toLowerCase().includes(needle) ||
      o.company.toLowerCase().includes(needle) ||
      matchesReportNo(query, o.evaluatedN),
  );
}

/**
 * The salary-floor DISPLAY filter (收件箱 facet 的姊妹过滤): keep a row when its
 * salary range's LOWER bound reaches the floor — strict, NOT the collection
 * gate's range-overlap. The gate answers 「谁可能给得到」 and keeps a 15-25K
 * posting when asked for 20 (never silently dropped on a technicality); a
 * display filter answers 「谁确实给得到」 — a row surviving a ≥20K filter while
 * its band starts at 15 would read as a bug on screen. Rows whose salary text
 * yields no monthly value are dropped too (no data, no way to confirm the
 * floor — same stance as the inbox facet), unlike the gate which keeps + tags
 * them. floor falsy/0 → off, everything passes. Pure — exported for tests.
 *
 * @param {Array<{salaryText?: string, source?: string}>} offers
 * @param {number | null} [salaryMinK] monthly floor in K (e.g. 20 = ≥20K/月)
 * @returns {Array<*>} the same offer objects, in input order.
 */
export function filterBySalaryMin(offers, salaryMinK) {
  const floor = Number(salaryMinK) || 0;
  if (floor <= 0) return offers;
  return offers.filter((o) => {
    // 解析口径复用采集门的 parseSalaryText（分板月薪折算），只是判定端更严。
    const source = String(o.source ?? "").replace(/^browser-/, "");
    const parsed = parseSalaryText(o.salaryText, source);
    return parsed !== null && parsed.minK >= floor;
  });
}
