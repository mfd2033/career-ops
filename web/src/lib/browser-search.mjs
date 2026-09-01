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
 */
export const SEARCH_TEMPLATES = {
  zhipin: "https://www.zhipin.com/web/geek/job?query={q}",
  liepin: "https://www.liepin.com/zhaopin/?key={q}",
  zhaopin: "https://sou.zhaopin.com/jobs/searchresult.ashx?t={q}",
};

/**
 * Build one search URL per requested source. Unknown sources are skipped, never
 * crashing — the user's browser does the heavy lifting and a stale template for
 * an unknown id must not sink the whole hunt.
 * @param {string[]} sources
 * @param {string} query
 * @returns {string[]}
 */
export function buildSearchUrls(sources, query) {
  const q = encodeURIComponent(String(query ?? ""));
  const out = [];
  for (const s of sources) {
    const tpl = SEARCH_TEMPLATES[s];
    if (tpl) out.push(tpl.replace("{q}", q));
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
 * contract: ?mode=browser&zh=<query>&sources=<csv>. The mode token is how a
 * restored URL knows to land in the browser surface.
 * @param {string} zhQuery
 * @param {string[]} sources
 * @returns {string}
 */
export function browserToParams(zhQuery, sources) {
  const sp = new URLSearchParams();
  sp.set("mode", "browser");
  if (String(zhQuery ?? "").trim()) sp.set("zh", String(zhQuery).trim());
  const clean = cleanBrowserSources(sources);
  if (clean.length) sp.set("sources", clean.join(","));
  return sp.toString();
}