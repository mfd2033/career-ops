/**
 * whats-new-filter.mjs — the "already evaluated?" filter for the whats-new
 * supply loop, extracted so node:test can regression-test it directly.
 *
 * The bug (#2666-adjacent, browser-board leak): scan-history rows written by
 * the browser-mode boards (智联/BOSS — runBrowserDiscovery hardcodes
 * `company: ""`) carry an EMPTY company column, so the old company-only
 * `evaluated.has(company)` guard short-circuited on the empty string and an
 * already-evaluated posting resurfaced as "new". The fix keys the evaluated
 * set TWO ways — by company AND by normalized posting URL — so a row leaks
 * only when it matches neither.
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
 * Build the row→offer mapper that also DROPS already-evaluated postings.
 * Mirrors the semantics the route used inline; extracted for testability.
 *
 * @param {{ norm: (s: string) => string, evaluated: Set<string>, evaluatedUrls: Set<string> }} ctx
 *   - norm: normalized-text key fn (from the core's normalizeTextKey)
 *   - evaluated: normalized company names already in the tracker
 *   - evaluatedUrls: canonical posting URLs already in the tracker
 * @param {string[]} c - scan-history row columns [url, first_seen, portal, title, company, status, location]
 * @returns {object|null} DiscoveredOffer-shaped object, or null when the row
 *   is malformed, expired, or already evaluated (by company OR URL).
 */
export function rowToOfferOrNull(ctx, c) {
  const { norm, evaluated, evaluatedUrls } = ctx;
  const [url, firstSeen, portal, title, company, status, location] = c;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (status && /skipped|expired/i.test(status)) return null;
  if (company && evaluated.has(norm(company))) return null;
  if (evaluatedUrls.has(normalizeUrl(url))) return null;
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
