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
 * The rows on screen: the tab's rows, narrowed by the keyword box (title or
 * company, case-insensitive). Order is NOT applied here — sorting is
 * presentation, and the header/tab counts deliberately look at the whole result
 * set rather than the filtered list.
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
  return list.filter((o) => o.title.toLowerCase().includes(needle) || o.company.toLowerCase().includes(needle));
}
