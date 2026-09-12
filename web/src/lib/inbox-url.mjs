/**
 * Navigation-readiness of a posting URL — pure, client-importable (.mjs so
 * node --test can lock it, same pattern as inbox-score.mjs).
 *
 * Distinct from normalizeUrl (url-key.mjs): that one exists for IDENTITY
 * comparison (dedup keys, score lookups) and may transform the URL (https
 * upgrade, tracking-param strip). Navigation is the browser + target site's
 * business — it gets the RAW url verbatim, no upgrade, no strip. A URL that
 * fails to parse as http(s) yields null and callers render plain text instead
 * of a dead link (hand-pasted pipeline rows can be malformed).
 */

/**
 * @param {string} raw - A posting URL (or any string).
 * @returns {string | null} The URL to open verbatim, or null when it must not
 *   become a link (unparseable or non-http(s)).
 */
export function openableUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}
