// Report-number search for the company/role search boxes.
//
// A user typing a bare tracker/report number ("64", "064", "#64") into a search
// box that otherwise matches company/role expects to jump straight to that row.
// The three boxes that carry a report number route through here so the rule is
// defined once and can't drift between them:
//   - pipeline-order.mjs  orderApplications  (tracker rows, `r.n`)
//   - followups-view.tsx  the urgency table   (cadence entries, `e.num`)
//   - results-view.mjs    visibleOffers        (explore offers, `o.evaluatedN`)
//
// Two deliberate constraints keep this safe as an ADD to substring search:
//   1. Only a query that is an optional '#' followed by digits and nothing else
//      is read as a report number, so ordinary text ("AI", "10x", "3 years")
//      is never hijacked into a numeric lookup.
//   2. Padding is tolerated the same way career-ops.ts's findReportFile resolves
//      a row (parseInt on both sides), so "#64" === "064" === "64".
//
// Callers OR this into their existing company/role match rather than replacing
// it, so a numeric query still hits a company literally named "Studio 64".

/**
 * Does a search query address this row by report number?
 *
 * @param {string} query - raw search-box text.
 * @param {string|number|null|undefined} n - the row's report number (may be
 *   absent, e.g. an explore offer that hasn't been evaluated yet).
 * @returns {boolean} true only when `query` is a bare number and equals `n`.
 */
export function matchesReportNo(query, n) {
  const q = String(query ?? "").trim();
  if (!/^#?\d+$/.test(q)) return false;
  const target = parseInt(q.replace(/^#/, ""), 10);
  const row = parseInt(String(n ?? "").replace(/^#/, ""), 10);
  return Number.isFinite(row) && row === target;
}
