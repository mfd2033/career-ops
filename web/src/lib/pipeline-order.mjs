// Shared tracker ordering/filtering — the SINGLE source of truth for "which
// rows does the pipeline table show, in what order".
//
// Both consumers must produce IDENTICAL results:
//   - pipeline-view.tsx      (the tracker table) — its `filtered` memo used to
//     inline this logic; it now calls orderApplications so the list can carry
//     its exact context into row links.
//   - pipeline/[id]/page.tsx (the report detail page) — reconstructs the same
//     ordered list from the URL context to compute prev/next navigation.
//
// The INBOX tab is special-cased to [] here exactly as the view did: the
// triage queue is NOT the tracker table, so it has no rows to navigate.
//
// Plain .mjs (like clean-chips.mjs / status-alias.mjs) so a `node --test` unit
// test can import it. Kept honest by tests/lib/pipeline-order.test.mjs.

import { canonStatus } from "./status-alias.mjs";
import { scoreNum } from "./score-num.mjs";

/** The tracker table's own default context — ALL rows, score descending. Used
 *  as the fallback when a report is opened without (or outside) a list
 *  context, so prev/next still work. */
export const DEFAULT_ORDER = {
  tab: "ALL",
  min: null,
  q: "",
  sortKey: "score",
  dir: -1,
};

const SORT_KEYS = ["company", "role", "score", "status", "date"];

/**
 * Filter + sort applications under the pipeline view's URL context.
 * @param {Array} applications - Application rows ({ n, company, role, score, status, date, ... }).
 * @param {{tab?: string, min?: number|null, q?: string, sortKey?: string, dir?: 1|-1}} ctx
 *   - tab: uppercase canonical tab (INBOX / ALL / EVALUATED / …). Default ALL.
 *   - min: numeric score floor; null/undefined disables.
 *   - q: company+role search needle.
 *   - sortKey: company | role | score | status | date. Default score.
 *   - dir: 1 ascending, -1 descending. Default -1.
 * @returns {Array} A NEW array (the view used `[...rows].sort`, callers must
 *   not mutate the input).
 */
export function orderApplications(applications, ctx = {}) {
  const tab = ctx.tab ?? "ALL";
  if (tab === "INBOX") return [];
  let rows = applications;
  if (tab !== "ALL") rows = rows.filter((r) => canonStatus(r.status).includes(tab));
  const min = ctx.min ?? null;
  if (min != null) {
    rows = rows.filter((r) => {
      const n = scoreNum(r.score);
      return !Number.isNaN(n) && n >= min;
    });
  }
  const q = ctx.q ?? "";
  if (q.trim()) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) => `${r.company} ${r.role}`.toLowerCase().includes(needle));
  }
  const sortKey = SORT_KEYS.includes(ctx.sortKey) ? ctx.sortKey : "score";
  const dir = ctx.dir === 1 ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sortKey === "score") {
      const an = scoreNum(a.score);
      const bn = scoreNum(b.score);
      const av = Number.isNaN(an) ? -Infinity : an;
      const bv = Number.isNaN(bn) ? -Infinity : bn;
      return (av - bv) * dir;
    }
    return (a[sortKey] || "").localeCompare(b[sortKey] || "") * dir;
  });
}

/**
 * Serialize the same context into a URL query string ("?tab=APPLIED&min=4…").
 * Used by pipeline-view.tsx to append context to row links and by the report
 * page to build prev/next + back links — both must emit IDENTICAL queries so a
 * round-trip preserves the view.
 *
 * The tab is ALWAYS serialized: the list page's no-param default is INBOX (the
 * triage queue), which has no tracker rows to link. Omitting tab=ALL would make
 * a row link (and the report page's back link) fall back to INBOX instead of
 * the table the user actually came from. Only min/sort/dir/q — whose omissions
 * resolve to the same tracker-table defaults — are elided.
 * @param {{tab?: string, min?: number|null, q?: string, sortKey?: string, dir?: 1|-1}} ctx
 * @returns {string} "?tab=ALL" for the empty/default context.
 */
export function buildContextQuery(ctx = {}) {
  const tab = ctx.tab ?? "ALL";
  const min = ctx.min ?? null;
  const q = (ctx.q ?? "").trim();
  const sortKey = SORT_KEYS.includes(ctx.sortKey) ? ctx.sortKey : "score";
  const dir = ctx.dir === 1 ? 1 : -1;
  const sp = new URLSearchParams();
  sp.set("tab", tab);
  if (min != null) sp.set("min", String(min));
  if (sortKey !== "score") sp.set("sort", sortKey);
  if (dir !== -1) sp.set("dir", "1");
  if (q) sp.set("q", q);
  return `?${sp.toString()}`;
}
