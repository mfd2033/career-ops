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
 * The company key is the FIRST dimension and it must be a REAL key. An empty
 * key is not a wildcard: browser-board scan rows carry `company: ""` (智联/BOSS
 * 采集时公司列就是空的), and the tracker writes `?` for an unknown employer
 * (ADR-0004 的 sentinel) — and `normalizeTextKey("?")` is ALSO the empty string.
 * Both sides normalizing to "" then matched on the role overlap alone, so every
 * 「产品经理」/「项目经理」 posting from 智联/BOSS was labelled 已评估 against a
 * single unrelated `?` row. Measured on the live data: 18 of the 200 whats-new
 * offers were falsely badged (and pushed out of the default 新增 tab) by 24
 * `?` rows, while not one of those postings existed in the tracker.
 *
 * @param {{company?: string, title?: string}} offer
 * @param {Array<{n?: string, company?: string, role?: string}>} apps
 * @param {(s: string) => string} norm - the core's normalizeTextKey key fn
 * @returns {string|undefined} the matched tracker `#n`, or undefined
 */
export function evaluatedNoFor(offer, apps, norm) {
  const c = norm(offer.company ?? "");
  if (!c) return undefined;
  const t = norm(offer.title ?? "");
  const hit = apps.find((a) => {
    if (norm(a.company ?? "") !== c) return false;
    const ar = norm(a.role ?? "");
    return ar.length > 3 && (t.includes(ar) || ar.includes(t.split(" ").slice(0, 3).join(" ")));
  });
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
