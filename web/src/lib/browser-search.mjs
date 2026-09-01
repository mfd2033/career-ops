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
  zhaopin: "https://sou.zhaopin.com/jobs/searchresult.ashx?t={q}",
};

/**
 * Logical Chinese city names → the platform-native value each board filters by.
 * Every entry here has been cross-checked against the live portals / public
 * scrapers (BOSS city codes, 猎聘 city-{slug} paths, 智联 `jl=` names). A city
 * NOT in this map is silently treated as "no city filter" (national search) —
 * the browser hunt never crashes over an unknown city.
 *
 *   • zhipin → `&city={code}`  (e.g. 郑州 = 101180100)
 *   • liepin → `/city-{slug}/` path segment (slug WITHOUT the city- prefix)
 *   • zhaopin → `&jl={name}`  (智联 takes the Chinese name verbatim)
 */
export const BROWSER_CITY_MAP = {
  北京: { zhipin: "101010100", liepin: "bj", zhaopin: "北京" },
  上海: { zhipin: "101020100", liepin: "sh", zhaopin: "上海" },
  广州: { zhipin: "101280100", liepin: "gz", zhaopin: "广州" },
  深圳: { zhipin: "101280600", liepin: "sz", zhaopin: "深圳" },
  杭州: { zhipin: "101210100", liepin: "hz", zhaopin: "杭州" },
  成都: { zhipin: "101270100", liepin: "cd", zhaopin: "成都" },
  武汉: { zhipin: "101200100", liepin: "wuhan", zhaopin: "武汉" },
  南京: { zhipin: "101190100", liepin: "nj", zhaopin: "南京" },
  苏州: { zhipin: "101190400", liepin: "suzhou", zhaopin: "苏州" },
  西安: { zhipin: "101110100", liepin: "xian", zhaopin: "西安" },
  天津: { zhipin: "101030100", liepin: "tj", zhaopin: "天津" },
  重庆: { zhipin: "101040100", liepin: "cq", zhaopin: "重庆" },
  郑州: { zhipin: "101180100", liepin: "zhengzhou", zhaopin: "郑州" },
  长沙: { zhipin: "101250100", liepin: "changsha", zhaopin: "长沙" },
  济南: { zhipin: "101120100", liepin: "jinan", zhaopin: "济南" },
  青岛: { zhipin: "101120200", liepin: "qingdao", zhaopin: "青岛" },
  合肥: { zhipin: "101220100", liepin: "hefei", zhaopin: "合肥" },
  福州: { zhipin: "101230100", liepin: "fuzhou", zhaopin: "福州" },
  厦门: { zhipin: "101230200", liepin: "xiamen", zhaopin: "厦门" },
  昆明: { zhipin: "101290100", liepin: "kunming", zhaopin: "昆明" },
  贵阳: { zhipin: "101260100", liepin: "guiyang", zhaopin: "贵阳" },
  南宁: { zhipin: "101300100", liepin: "nanning", zhaopin: "南宁" },
  海口: { zhipin: "101310100", liepin: "haikou", zhaopin: "海口" },
  南昌: { zhipin: "101240100", liepin: "nanchang", zhaopin: "南昌" },
  太原: { zhipin: "101100100", liepin: "taiyuan", zhaopin: "太原" },
  石家庄: { zhipin: "101090100", liepin: "shijiazhuang", zhaopin: "石家庄" },
  呼和浩特: { zhipin: "101080100", liepin: "huhehaote", zhaopin: "呼和浩特" },
  沈阳: { zhipin: "101070100", liepin: "shenyang", zhaopin: "沈阳" },
  大连: { zhipin: "101070200", liepin: "dalian", zhaopin: "大连" },
  长春: { zhipin: "101060100", liepin: "changchun", zhaopin: "长春" },
  哈尔滨: { zhipin: "101050100", liepin: "haerbin", zhaopin: "哈尔滨" },
  兰州: { zhipin: "101160100", liepin: "lanzhou", zhaopin: "兰州" },
  乌鲁木齐: { zhipin: "101130100", liepin: "wulumuqi", zhaopin: "乌鲁木齐" },
  西宁: { zhipin: "101150100", liepin: "xining", zhaopin: "西宁" },
  银川: { zhipin: "101170100", liepin: "yinchuan", zhaopin: "银川" },
};

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
      return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${source === "zhipin" ? "city" : "jl"}=${encodeURIComponent(native)}`;
    case "liepin":
      // https://www.liepin.com/zhaopin/?key=… → https://www.liepin.com/city-zhengzhou/zhaopin/?key=…
      return baseUrl.replace(/^(\w+:\/\/[^/]+\/)/, `$1city-${encodeURIComponent(native)}/`);
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
 * Extract the first searchable Chinese phrase from a portals.yml
 * `search_queries[].query` string (the CLI scan's WebSearch syntax), so the
 * Explorer's browser mode can seed its keyword box with the same intent.
 * The CLI form looks like:
 *   'site:zhipin.com 项目经理 郑州 OR 技术经理 郑州 OR IT项目经理 郑州'
 * We drop every `site:` token and the bare `OR` separators, then keep the
 * tokens up to the first `OR` — the most specific first candidate — and join
 * them back with spaces. A query with no `OR` keeps all its non-site tokens.
 * Returns "" for anything that yields no phrase.
 * @param {string} searchQuery
 * @returns {string}
 */
export function extractBrowserQuery(searchQuery) {
  const tokens = String(searchQuery ?? "")
    .trim()
    .split(/\s+/)
    .filter((t) => t && !/^site:/i.test(t));
  const group = [];
  for (const t of tokens) {
    if (/^OR$/i.test(t)) {
      // A separator between groups: stop only once a group was collected;
      // a leading/consecutive OR is just noise to skip, not a boundary.
      if (group.length > 0) break;
      continue;
    }
    group.push(t);
  }
  return group.join(" ").trim();
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
 * contract: ?mode=browser&zh=<query>&sources=<csv>[&city=<name>]. The mode token
 * is how a restored URL knows to land in the browser surface; the optional
 * `city` param carries the logical Chinese city name so a city-filtered hunt
 * restores with its filter intact.
 * @param {string} zhQuery
 * @param {string[]} sources
 * @param {string} [cityName] logical Chinese city, e.g. "郑州"; omitted = national
 * @returns {string}
 */
export function browserToParams(zhQuery, sources, cityName) {
  const sp = new URLSearchParams();
  sp.set("mode", "browser");
  if (String(zhQuery ?? "").trim()) sp.set("zh", String(zhQuery).trim());
  const clean = cleanBrowserSources(sources);
  if (clean.length) sp.set("sources", clean.join(","));
  const city = String(cityName ?? "").trim();
  if (city) sp.set("city", city);
  return sp.toString();
}