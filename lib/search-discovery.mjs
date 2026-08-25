// search-discovery.mjs — web-search discovery lane for scan.mjs.
//
// Turns the long-dead `search_queries` config into a real discovery channel:
// each enabled query is run through a search engine and the result links are
// parsed into Job-like rows, then filtered and deduped exactly like provider
// output. Kept zero-token: a single Bing HTML GET per query, no LLM calls.
//
// NOTE ON CHINESE JOB BOARDS: liepin / zhaopin / 51job / zhipin / lagou block
// search-engine indexing of detail pages and serve anti-bot/captcha to headless
// and even logged-out browsers. For those, web search returns ~0 job links; the
// practical 郑州 channel is `parse-inbound.mjs` (user saves a results page from
// their own logged-in browser and the tool parses it). This lane is correct and
// verifiable infrastructure — it surfaces whatever the engine indexes.

const BING = 'https://www.bing.com/search';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** @param {string} url @returns {string} host, or '' if unparseable. */
export function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Parse a Bing search-results HTML page into candidate result links.
 * Pure — exported for unit testing. Tolerant of minor markup drift: it walks
 * each `<li class="b_algo">` block and reads the headline `<h2><a href>`.
 *
 * @param {string} html
 * @returns {Array<{ url: string, title: string }>}
 */
export function parseSearchResults(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const out = [];
  const seen = new Set();
  const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1];
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = a[1];
    const title = a[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^https?:\/\//i.test(url) || !title) continue;
    const key = url.replace(/[#?].*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title });
  }
  return out;
}

/**
 * Run a single search query and return parsed candidates.
 * @param {string} query
 * @param {{ fetchText: (url: string, opts?: unknown) => Promise<string> }} ctx
 * @returns {Promise<Array<{ url: string, title: string }>>}
 */
export async function discoverFromSearch(query, ctx) {
  if (typeof query !== 'string' || !query.trim()) return [];
  const url = `${BING}?q=${encodeURIComponent(query)}`;
  const html = await ctx.fetchText(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  return parseSearchResults(html);
}
