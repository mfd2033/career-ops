// browser-search.mjs — pure helpers for the Explorer's THIRD discovery mode:
// "browser" scans the Chinese boards (BOSS直聘/猎聘/智联招聘) through the user's
// OWN logged-in browser via bsk-extract.mjs (those boards wall headless and
// logged-out browsers). Plain .mjs on purpose: node:test can import it directly,
// and the Next.js app (client-safe types in lib/explore.ts) re-exports the
// constants from here so UI chrome and server routing can never drift.

/** The closed set of Chinese job boards the browser mode can search. */
export const BROWSER_SOURCES = ["zhipin", "liepin", "zhaopin"];

/**
 * Search-URL templates per platform. `{q}` is replaced with the URI-encoded
 * Chinese query. These are the pages bsk-extract.mjs navigates to in the user's
 * logged-in browser; it then collects every job-detail anchor on the page.
 *
 * Each template is the NATIONAL (no city) search. When a known city is passed
 * to buildSearchUrls, the platform-native city slot is added per source —
 * see BROWSER_CITY_MAP and applyBrowserCity below.
 */
export const SEARCH_TEMPLATES = {
  zhipin: "https://www.zhipin.com/web/geek/job?query={q}",
  liepin: "https://www.liepin.com/zhaopin/?key={q}",
  zhaopin: "https://www.zhaopin.com/jobs?kw={q}",
};

/**
 * Logical Chinese city names → the platform-native value each board filters by.
 * Every entry here has been cross-checked against the live portals / public
 * scrapers (BOSS city codes, 猎聘 city-{slug} paths, 智联 `jl=` names). A city
 * NOT in this map is silently treated as "no city filter" (national search) —
 * the browser hunt never crashes over an unknown city.
 *
 *   • zhipin → `&city={code}`  (e.g. 郑州 = 101180100)
 *   • liepin → `&dq={code}`   (dq 数字城市码，e.g. 郑州 = 150020; 替代已失效的 /city-{slug}/ 路径)
 *   • zhaopin → `&jl={code}`  (智联数字城市码，e.g. 郑州 = 719; 中文名 jl 已失效, 返回全国职位)
 */
export const BROWSER_CITY_MAP = {
  北京: { zhipin: "101010100", liepin: "010", zhaopin: "530" },
  上海: { zhipin: "101020100", liepin: "020", zhaopin: "538" },
  广州: { zhipin: "101280100", liepin: "050020", zhaopin: "763" },
  深圳: { zhipin: "101280600", liepin: "050090", zhaopin: "765" },
  杭州: { zhipin: "101210100", liepin: "070020", zhaopin: "653" },
  成都: { zhipin: "101270100", liepin: "280020", zhaopin: "801" },
  武汉: { zhipin: "101200100", liepin: "170020", zhaopin: "736" },
  南京: { zhipin: "101190100", liepin: "060020", zhaopin: "635" },
  苏州: { zhipin: "101190400", liepin: "060080", zhaopin: "639" },
  西安: { zhipin: "101110100", liepin: "270020", zhaopin: "854" },
  天津: { zhipin: "101030100", liepin: "030", zhaopin: "531" },
  重庆: { zhipin: "101040100", liepin: "040", zhaopin: "551" },
  郑州: { zhipin: "101180100", liepin: "150020", zhaopin: "719" },
  长沙: { zhipin: "101250100", liepin: "180020", zhaopin: "749" },
  济南: { zhipin: "101120100", liepin: "250020", zhaopin: "702" },
  青岛: { zhipin: "101120200", liepin: "250070", zhaopin: "703" },
  合肥: { zhipin: "101220100", liepin: "080020", zhaopin: "664" },
  福州: { zhipin: "101230100", liepin: "090020", zhaopin: "681" },
  厦门: { zhipin: "101230200", liepin: "090040", zhaopin: "682" },
  昆明: { zhipin: "101290100", liepin: "310020", zhaopin: "831" },
  贵阳: { zhipin: "101260100", liepin: "120020", zhaopin: "822" },
  南宁: { zhipin: "101300100", liepin: "110020", zhaopin: "785" },
  海口: { zhipin: "101310100", liepin: "130020", zhaopin: "799" },
  南昌: { zhipin: "101240100", liepin: "200020", zhaopin: "691" },
  太原: { zhipin: "101100100", liepin: "260020", zhaopin: "576" },
  石家庄: { zhipin: "101090100", liepin: "140020", zhaopin: "565" },
  呼和浩特: { zhipin: "101080100", liepin: "220020", zhaopin: "587" },
  沈阳: { zhipin: "101070100", liepin: "210020", zhaopin: "599" },
  大连: { zhipin: "101070200", liepin: "210040", zhaopin: "600" },
  长春: { zhipin: "101060100", liepin: "190020", zhaopin: "613" },
  哈尔滨: { zhipin: "101050100", liepin: "160020", zhaopin: "622" },
  兰州: { zhipin: "101160100", liepin: "100020", zhaopin: "864" },
  乌鲁木齐: { zhipin: "101130100", liepin: "300020", zhaopin: "890" },
  西宁: { zhipin: "101150100", liepin: "240020", zhaopin: "878" },
  银川: { zhipin: "101170100", liepin: "230020", zhaopin: "886" },
};

/**
 * The logical Chinese city names (BROWSER_CITY_MAP keys) as a flat array.
 * Consumed by bsk-extract.mjs to build the in-browser card-text matcher for
 * the city-extraction pass (方案1): zhipin/liepin anchors carry no structured
 * city, so the extraction scans the card text for the first known city name.
 * Exported here so the injected page script and the Node-side tests share ONE
 * list — the map keys are the source of truth.
 */
export const CITY_NAMES = Object.keys(BROWSER_CITY_MAP);

/**
 * Inject a platform-native city slot into a search URL. Pure — exported for
 * tests. Returns the URL unchanged when the source has no city mechanism or
 * the native value is empty (national search).
 * @param {string} source
 * @param {string} baseUrl
 * @param {string} nativeValue
 * @returns {string}
 */
export function applyBrowserCity(source, baseUrl, nativeValue) {
  const native = String(nativeValue ?? "").trim();
  if (!native) return baseUrl;
  switch (source) {
    case "zhipin":
    case "zhaopin":
    case "liepin":
      // BOSS → &city=<code>; 智联 → &jl=<name>; 猎聘 → &dq=<code> (城市码，替代已失效的
      // /city-{slug}/ 路径——slug 不产生城市过滤，dq 参数实测有效)
      return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${source === "zhipin" ? "city" : source === "zhaopin" ? "jl" : "dq"}=${encodeURIComponent(native)}`;
    default:
      return baseUrl;
  }
}

/**
 * Resolve a logical Chinese city name to the platform-native search value, or ""
 * when the city is unknown/empty (national search). Pure — exported for tests.
 * @param {string} source
 * @param {string} cityName
 * @returns {string}
 */
export function browserCityValue(source, cityName) {
  const name = String(cityName ?? "").trim();
  if (!name) return "";
  const entry = BROWSER_CITY_MAP[name];
  return entry ? String(entry[source] ?? "") : "";
}

/**
 * Q2 zero-tolerance post-discovery gate: is this discovered job in the target
 * city? A job that carries an explicit city field (e.g. 智联's positionList
 * `workCity`) is judged on that field FIRST — it is the reliable signal; the
 * title is only a fallback for platforms whose list cards don't expose a city
 * (猎聘/BOSS anchors). When a city is requested it MUST match — a job with no
 * matching city/title signal is dropped, never kept on trust that the search
 * URL's city parameter filtered it. No city requested → everything passes.
 * Pure — exported for tests.
 * @param {{ city?: string, title?: string } | undefined} job
 * @param {string} [cityName] logical Chinese city, e.g. "郑州"; "" = no gate
 * @returns {boolean}
 */
export function matchesBrowserCity(job, cityName) {
  const city = String(cityName ?? "").trim();
  if (!city) return true;
  const jobCity = String(job?.city ?? "").trim();
  if (jobCity) {
    // workCity values are usually exact ("郑州") but can be compound
    // ("郑州 金水区") — accept either containment direction.
    return jobCity === city || jobCity.includes(city) || city.includes(jobCity);
  }
  return String(job?.title ?? "").includes(city);
}

// ── 薪资条件（探索页 browser 模式「最低月薪」，工单 01）──────────────────
//
// 口径约定（CONTEXT.md「薪资文本」词条）：内部统一为月薪 K（千元/月）。
//   • K/千    → 月薪直取
//   • 智联「万」→ 月薪 ×10
//   • 猎聘裸「万」（无 /年 标记）→ 年薪 ÷12
//   • 显式「/年」「年薪」→ 年薪 ÷12，与站点无关
//   • 「·N薪」年度系数在比较中忽略（输入与展示同为月薪口径）
//   • 「元/天」等非月薪口径、乱文本、无薪资 → 解析失败（薪资未知）
// 比较语义沿用 scan.mjs salary_filter 的「区间重叠、不误删」取向。

/**
 * Parse a raw card salary string into a monthly-K range, or null when the text
 * carries no monthly-salary value (面议 / 元/天 / garbage). Pure — exported for
 * tests. `source` is the board id ("zhipin"/"liepin"/"zhaopin"); DiscoveredOffer's
 * "browser-{source}" form is accepted too. An unknown source treats a bare 万
 * as monthly (智联's usage — the only board where 万 is the DEFAULT form).
 * @param {string} [text]
 * @param {string} [source]
 * @returns {{ minK: number, maxK: number } | null}
 */
export function parseSalaryText(text, source) {
  const t = String(text ?? "")
    .replace(/\s+/g, "")
    .replace(/[–—~～]/g, "-");
  if (!t) return null;
  // 非月薪口径（日/时/周薪等）一律解析失败 → 薪资未知，绝不硬折算。
  if (/元?\/(天|日|时|周|小时)/.test(t)) return null;
  // 区间优先（首值单位可省可带：20-35K / 20K-35K / 2万-3万），再退单值（30K / 2.5万）。
  // 具名捕获组：两条正则的组数不同，按名取值避免解构错位；首值单位独立捕获，
  // 混合单位区间（8千-1.2万）各按自身单位折算，不沿用尾值单位。
  // 「元」= 智联的元/月薪形态（7000-8000元），÷1000 折算 K。
  const m =
    t.match(/(?<lo>\d+(?:\.\d+)?)(?<lounit>千|k|K|万|元)?-(?<hi>\d+(?:\.\d+)?)(?<unit>千|k|K|万|元)(?![a-zA-Z])/) ||
    t.match(/(?<lo>\d+(?:\.\d+)?)(?<unit>千|k|K|万|元)(?![a-zA-Z])/);
  if (!m) return null;
  const { lo, hi, lounit, unit } = m.groups;
  // 显式年薪标记优先于站点口径。
  const annual =
    /\/年|年薪/.test(t) ||
    ((unit === "万" || lounit === "万") && String(source ?? "").replace(/^browser-/, "") === "liepin");
  const toK = (v, u) => {
    let base = v;
    if (u === "万") base = v * 10;
    else if (u === "元") base = v / 1000;
    return Math.round((annual ? base / 12 : base) * 10) / 10;
  };
  // 校验放在折算后：混合单位区间的原始值不可比（8千-1.2万 折算前是 8 vs 1.2）。
  const minK = toK(Number(lo), lounit || unit);
  const maxK = toK(Number(hi ?? lo), unit);
  if (!Number.isFinite(minK) || !Number.isFinite(maxK) || minK <= 0 || maxK < minK) return null;
  return { minK, maxK };
}

/**
 * Strip font-obfuscation private-use codepoints from a raw salary string. BOSS
 * renders salary DIGITS as PUA glyphs (anti-scrape font mapping — 实证
 * data/pipeline.md: `\uE032\uE036-\uE034\uE031K`), so the DOM text carries
 * unrenderable/unparseable codepoints where digits should be. After stripping,
 * a salary with no ASCII digits left parses to null downstream → the offer rides
 * the 薪资未知 path instead of showing a garbled badge. Pure — exported for tests.
 * @param {string} [text]
 * @returns {string}
 */
export function cleanSalaryText(text) {
  return String(text ?? "")
    .replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, "")
    .trim();
}

/** The raw salary text carried by a listing job / DiscoveredOffer, from either
 *  field name (bsk listing uses `salary`, the offer contract uses `salaryText`),
 *  PUA-stripped so font-obfuscated cards ride the 薪资未知 path. */
function salaryTextOf(job) {
  return cleanSalaryText(job?.salaryText ?? job?.salary);
}

/** The board id a salary text should be parsed under, accepting both the bare
 *  source ("liepin") and the DiscoveredOffer form ("browser-liepin"). */
function salarySourceOf(job) {
  return String(job?.source ?? "").replace(/^browser-/, "");
}

/**
 * Browser-mode salary gate, sibling of matchesBrowserCity: keep a job when its
 * salary range OVERLAPS the requested floor (range max ≥ floor — the salary_filter
 * "never drop on a technicality" stance; a 15-25K posting can genuinely pay 25).
 * Missing/unparseable salary → KEEP (薪资未知放行, never silently dropped) —
 * pair with isSalaryUnknown to surface the "薪资未知" marker. floor falsy/0 →
 * the gate is off, everything passes. Pure — exported for tests.
 * @param {{ salary?: string, salaryText?: string, source?: string } | undefined} job
 * @param {number} [salaryMinK] monthly floor in K (e.g. 20 = ≥20K/月)
 * @returns {boolean}
 */
export function matchesBrowserSalary(job, salaryMinK) {
  const floor = Number(salaryMinK) || 0;
  if (floor <= 0) return true;
  const parsed = parseSalaryText(salaryTextOf(job), salarySourceOf(job));
  if (!parsed) return true; // 薪资未知 → 放行（与 salary_filter「无数据不误删」一致）
  return parsed.maxK >= floor;
}

/**
 * Does this job's salary text fail to yield a monthly value? Used to tag kept
 * unknowns with the「薪资未知」marker whenever a floor gate is active. Pure —
 * exported for tests.
 * @param {{ salary?: string, salaryText?: string, source?: string } | undefined} job
 * @returns {boolean}
 */
export function isSalaryUnknown(job) {
  return parseSalaryText(salaryTextOf(job), salarySourceOf(job)) === null;
}

/**
 * Apply the salary floor gate to a LIST of jobs/offers — the single shared
 * implementation behind both drivers (工单 03/04): bsk's server gate
 * (browser-scan.ts) and the extension path's page-side gate (explore-provider)
 * consume this so their keep/drop/未知-tag semantics can never drift. Jobs
 * failing matchesBrowserSalary drop; kept jobs whose salary text parses to no
 * monthly value get `salaryUnknown: true`. floor falsy/0 → returned unchanged
 * (gate off). Pure — exported for tests.
 *
 * `defaultSource` is the board the CALLER already knows. Salary口径 is per-board
 * (猎聘's bare 万 is annual, 智联's is monthly — 工单 01), and the parse falls
 * back to the unknown-source reading when a row carries no `source`. bsk's
 * listing rows are exactly that list — `{title,url,city,salary}`, no source
 * (`normalizeListing` drops unknown anchor fields) — so `browser-scan.ts` passes
 * the platform it is currently collecting. Without it every 猎聘 bare 万 parses
 * as 智联's ×10 and the floor silently stops filtering that board. A row that
 * carries its own `source` keeps it; the extension path needs no fallback
 * because its offers are stamped at construction (`scan-pure.js`).
 * @param {Array<{ salary?: string, salaryText?: string, source?: string }>} [jobs]
 * @param {number} [salaryMinK] monthly floor in K
 * @param {string} [defaultSource] board id for rows without one ("liepin"/…)
 * @returns {Array<*>}
 */
export function applyBrowserSalaryGate(jobs, salaryMinK, defaultSource) {
  const floor = Number(salaryMinK) || 0;
  const list = Array.isArray(jobs) ? jobs : [];
  if (floor <= 0) return list;
  const board = String(defaultSource ?? "");
  const withBoard = board
    ? list.map((j) => (j && typeof j === "object" && !j.source ? { ...j, source: board } : j))
    : list;
  return withBoard.filter((j) => matchesBrowserSalary(j, floor)).map((j) => (isSalaryUnknown(j) ? { ...j, salaryUnknown: true } : j));
}

/**
 * Extract the position-keyword-only seed from a portals.yml `search_queries[].query`
 * string (the CLI scan's WebSearch syntax), so the Explorer's browser mode can fill
 * its keyword box with the same intent. The CLI form looks like:
 *   'site:zhipin.com 项目经理 郑州 OR 技术经理 郑州 OR IT项目经理 郑州'
 * Every `site:` token, every bare `OR` separator, AND every token that names a known
 * city (a BROWSER_CITY_MAP key) is dropped — the browser hunt applies its city filter
 * separately via the zhCity box / the search-URL city slot, so the city must not leak
 * into the keyword field. What remains is the position selection across ALL `OR`
 * groups (not just the first), joined with a single space (one keyword per token; the
 * search stage re-expands spaces back to `OR`, see runBrowserDiscovery).
 * Returns "" for anything that yields no phrase.
 * @param {string} searchQuery
 * @returns {string}
 */
export function extractBrowserQuery(searchQuery) {
  const citySet = new Set(CITY_NAMES);
  const tokens = String(searchQuery ?? "")
    .trim()
    .split(/\s+/)
    .filter((t) => t && !/^site:/i.test(t) && !/^OR$/i.test(t) && !citySet.has(t));
  return tokens.join(" ").trim();
}

/**
 * Build one search URL per requested source. Unknown sources are skipped, never
 * crashing — the user's browser does the heavy lifting and a stale template for
 * an unknown id must not sink the whole hunt. A KNOWN Chinese city is appended
 * per-source (native slot); an unknown/empty city keeps the national search.
 * @param {string[]} sources
 * @param {string} query
 * @param {string} [cityName] logical Chinese city, e.g. "郑州"; "" = national
 * @returns {string[]}
 */
export function buildSearchUrls(sources, query, cityName) {
  const q = encodeURIComponent(String(query ?? ""));
  const out = [];
  for (const s of sources) {
    const tpl = SEARCH_TEMPLATES[s];
    if (!tpl) continue;
    const base = tpl.replace("{q}", q);
    out.push(applyBrowserCity(s, base, browserCityValue(s, cityName)));
  }
  return out;
}

/**
 * 扩展/bsk 采集的目标展开：返回 {source, url}[]（成对，避免 buildSearchUrls 的
 * source↔url 齐序被拆词破坏）。
 *
 * 猎聘搜索框**不支持** `OR`/空格分隔的多关键词 —— 只认单关键词，整串会被当字面
 * 关键词匹配而漏采。故对猎聘把 OR 分隔的词组逐词拆成多条搜索 URL（每词一次采集）；
 * BOSS/智联搜索框接受空格/OR 分隔的多候选，维持整串一条。
 *
 * @param {string[]} sources
 * @param {string} query 已含 ` OR ` 分隔的查询串（调用方构成）
 * @param {string} [cityName] logical Chinese city, e.g. "郑州"; "" = national
 * @returns {Array<{source: string, url: string}>}
 */
export function expandSearchTargets(sources, query, cityName) {
  const out = [];
  for (const s of sources) {
    const tpl = SEARCH_TEMPLATES[s];
    if (!tpl) continue;
    const append = (word) => {
      const base = tpl.replace("{q}", encodeURIComponent(String(word ?? "").trim()));
      out.push({ source: s, url: applyBrowserCity(s, base, browserCityValue(s, cityName)) });
    };
    if (s === "liepin") {
      // 猎聘单关键词限制：按 OR 拆词逐条。空段丢弃；纯空白查询退化为全国空搜。
      const words = String(query ?? "")
        .split(/ OR | or /i)
        .map((w) => w.trim())
        .filter(Boolean);
      (words.length ? words : [""]).forEach(append);
    } else {
      append(String(query ?? "").trim() || "");
    }
  }
  return out;
}

/** Keep only known browser sources; the empty/absent/ non-array value means "all". */
export function cleanBrowserSources(v) {
  if (!Array.isArray(v)) return [...BROWSER_SOURCES];
  const out = [];
  for (const s of v) {
    if (BROWSER_SOURCES.includes(String(s).toLowerCase()) && !out.includes(String(s).toLowerCase())) {
      out.push(String(s).toLowerCase());
    }
  }
  return out.length ? out : [...BROWSER_SOURCES];
}

/** Parse a comma-separated source list (URL codec restore). Unknown ids drop out.
 *  Empty/absent → [] (the caller applies its default; parse never invents one). */
export function parseBrowserSources(s) {
  if (typeof s !== "string" || !s.trim()) return [];
  const out = [];
  for (const x of s.split(",")) {
    const t = String(x).trim().toLowerCase();
    if (BROWSER_SOURCES.includes(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Browser-mode URL codec (shareable/restorable hunt), mirroring aiToParams's
 * contract: ?mode=browser&zh=<query>&sources=<csv>[&city=<name>][&smin=<K>]. The
 * mode token is how a restored URL knows to land in the browser surface; the
 * optional `city` param carries the logical Chinese city name so a city-filtered
 * hunt restores with its filter intact; `smin` carries the 薪资下限 (monthly K).
 * @param {string} zhQuery
 * @param {string[]} sources
 * @param {string} [cityName] logical Chinese city, e.g. "郑州"; omitted = national
 * @param {number} [salaryMinK] salary floor in monthly K (e.g. 20); 0/omitted = off
 * @returns {string}
 */
export function browserToParams(zhQuery, sources, cityName, salaryMinK) {
  const sp = new URLSearchParams();
  sp.set("mode", "browser");
  if (String(zhQuery ?? "").trim()) sp.set("zh", String(zhQuery).trim());
  const clean = cleanBrowserSources(sources);
  if (clean.length) sp.set("sources", clean.join(","));
  const city = String(cityName ?? "").trim();
  if (city) sp.set("city", city);
  const smin = Number(salaryMinK);
  if (Number.isFinite(smin) && smin > 0) sp.set("smin", String(Math.round(smin * 10) / 10));
  return sp.toString();
}