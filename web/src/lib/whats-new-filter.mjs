/**
 * whats-new-filter.mjs — the "already evaluated?" filter for the whats-new
 * supply loop, extracted so node:test can regression-test it directly.
 *
 * Two leak classes this filter closes, both proven by real data:
 *
 * 1. Evaluated postings resurfacing (#2666-adjacent, browser-board leak):
 *    scan-history rows written by the browser-mode boards (智联/BOSS —
 *    runBrowserDiscovery hardcodes `company: ""`) carry an EMPTY company
 *    column, so the old company-only `evaluated.has(company)` guard
 *    short-circuited on the empty string and an already-evaluated posting
 *    resurfaced as "new". The fix keys the evaluated set TWO ways — by company
 *    AND by normalized posting URL — so a row leaks only when it matches
 *    neither.
 *
 * 2. Pending-in-pipeline postings resurfacing (pipeline leak): a browser-mode
 *    scan writes the SAME discovery to both data/scan-history.tsv (as a new
 *    "first seen this week" row) and data/pipeline.md (as a pending `- [ ]`
 *    inbox row). The whats-new supply loop then re-offers a posting the user
 *    already queued — showing an "已在管道中" card under "本周新匹配". The
 *    `pipelineUrls` dimension drops any scan row whose URL already sits in the
 *    inbox (done rows excluded: a processed posting is handled by the
 *    evaluated dimensions, not this one).
 *
 * URL keys use the core's canonical `normalizeUrl` (url-key.mjs mirror). It
 * strips only campaign params (utm_*, gh_src, …) and folds scheme/host/
 * trailing-slash drift, so a scan URL recorded with http:// or a stray slash
 * still keys to the tracker URL. A posting URL that grew a NON-campaign param
 * after evaluation (e.g. zhipin's ?securityId=...) keys differently and is
 * caught only by the company dimension — fine in practice, because browser-
 * board scan rows (the ones with empty company) carry the clean base link
 * recorded at discovery time.
 */
import { normalizeUrl } from "./core/url-key.mjs";

/**
 * Build the row→offer mapper that also DROPS already-evaluated and
 * already-pending postings. Mirrors the semantics the route used inline;
 * extracted for testability.
 *
 * @param {{ norm: (s: string) => string, evaluated: Set<string>, evaluatedUrls: Set<string>, pipelineUrls?: Set<string> }} ctx
 *   - norm: normalized-text key fn (from the core's normalizeTextKey)
 *   - evaluated: normalized company names already in the tracker
 *   - evaluatedUrls: canonical posting URLs already in the tracker
 *   - pipelineUrls: canonical posting URLs pending in the inbox (data/pipeline.md
 *     `- [ ]` rows). Optional — absent means "don't filter on the pipeline".
 * @param {string[]} c - scan-history row columns [url, first_seen, portal, title, company, status, location]
 * @returns {object|null} DiscoveredOffer-shaped object, or null when the row
 *   is malformed, expired, already evaluated (by company OR URL), or already
 *   pending in the pipeline (by URL).
 */
export function rowToOfferOrNull(ctx, c) {
  const { norm, evaluated, evaluatedUrls, pipelineUrls } = ctx;
  const [url, firstSeen, portal, title, company, status, location] = c;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (status && /skipped|expired/i.test(status)) return null;
  if (company && evaluated.has(norm(company))) return null;
  if (evaluatedUrls.has(normalizeUrl(url))) return null;
  if (pipelineUrls && pipelineUrls.has(normalizeUrl(url))) return null;
  return {
    url,
    company: (company || "").trim(),
    title: (title || "").trim(),
    location: (location || "").trim(),
    postedAt: /^\d{4}-\d{2}-\d{2}$/.test(firstSeen || "") ? firstSeen : "",
    ats: (portal || "").replace(/-full$/, "").trim() || "other",
    source: "whats-new",
  };
}

export { normalizeUrl };
