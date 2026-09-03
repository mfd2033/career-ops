// Inbox score resolution: which evaluation facts drive the "scored" signal on a
// triage row. Two sources, two lifetimes:
//
//   live      — the session job-store (evaluate workers fired THIS browser).
//               Fresh + real-time: a running spinner, or a brand-new verdict.
//               Ephemeral: it evaporates with localStorage (40-job cap, clear
//               history, different browser), so it can NEVER be the only source.
//   persisted — the durable evaluation on disk: a tracker row whose report
//               carries the posting's `**URL:**` header (built server-side by
//               buildScoreByUrl). Survives everything the live store doesn't.
//
// The row shows a score if EITHER source has one. Live wins while it is
// meaningful (running → spinner, score → fresh verdict); persisted is the
// fallback that keeps an already-evaluated posting from lying "not scored"
// after a refresh / CLI-side evaluation.

import { normalizeUrl } from "./core/url-key.mjs";

/**
 * @typedef {Object} InboxRowScore
 * @property {number|null} score
 * @property {"good"|"warn"|"bad"|"muted"} tone
 * @property {string} jobId - "" when the score came from a persisted report
 *   (no live worker page to link to).
 * @property {boolean} running
 */

/**
 * Decide the RowScore a triage row should display for a posting URL.
 *
 * @param {InboxRowScore|undefined} live - session job-store entry for the URL
 *   ({ running, score, tone?, jobId }) — undefined when this browser never
 *   evaluated it.
 * @param {InboxRowScore|undefined} persisted - durable disk score for the URL
 *   — undefined when the posting was never evaluated on disk.
 * @returns {InboxRowScore|undefined} the effective row score, or undefined
 *   when the posting has never been evaluated anywhere.
 */
export function resolveRowScore(live, persisted) {
  // A live entry only wins while it carries displayable truth: still running
  // (spinner) or actually holding a verdict. A finished-but-verdictless live
  // entry (failed eval) must not hide a persisted score behind "not scored" —
  // the honest display is the durable fact, if any.
  if (live && (live.running || live.score != null)) return live;
  return persisted ?? undefined;
}

/**
 * Build the URL → { score, tone? } map from the durable source of truth: each
 * tracker APPLICATION that resolves to a real http(s) posting URL (via its
 * report `**URL:**` header). Tolerant: apps with no resolvable URL simply drop.
 *
 * Keys are normalizeUrl(url) so lookups made client-side from a raw posting URL
 * (pipeline.md text) match regardless of tracking params / trailing slash /
 * host case — the same canonical key both sides import.
 *
 * @param {Array<{n: string, score: string}>} apps - parsed tracker rows.
 * @param {(app: *) => (string|undefined)} readUrl - resolves an app's
 *   posting URL from its report (server-side injection; no fs here so it stays
 *   importable by client bundles and node:test).
 * @returns {Record<string, {score: string}>} key → tracker score string.
 */
export function buildScoreByUrl(apps, readUrl) {
  const m = {};
  for (const app of apps) {
    const url = readUrl(app);
    if (!url || typeof url !== "string") continue;
    const key = normalizeUrl(url);
    if (!key) continue;
    // first app wins per URL — the tracker lists each posting once; a duplicate
    // row (company+role rerecorded) shouldn't overwrite the earlier score.
    if (!(key in m)) m[key] = { score: app.score };
  }
  return m;
}