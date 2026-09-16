// Tests for the shared pipeline ordering/filtering used by BOTH the tracker
// table (pipeline-view.tsx) and the report detail page's prev/next navigation
// (pipeline/[id]/page.tsx). The detail page must reproduce the list view's
// filter+sort context exactly, so this module is the one source of truth and
// the two consumers must never drift — these tests lock that contract.
//
// Run:  node --test tests/lib/pipeline-order.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { orderApplications, buildContextQuery, countSelectedOffView } from "../../src/lib/pipeline-order.mjs";

// Minimal Application-shaped fixtures (only the fields the ordering touches).
const apps = [
  { n: "1", company: "Acme", role: "Senior Engineer", score: "4.2/5", status: "Evaluated", date: "2026-08-01" },
  { n: "2", company: "Beta", role: "Data Analyst", score: "3.1/5", status: "Applied", date: "2026-08-03" },
  { n: "3", company: "Acme", role: "Data Engineer", score: "", status: "Applied", date: "2026-08-02" },
  { n: "4", company: "Gamma", role: "ML Engineer", score: "2.4/5", status: "Interview", date: "2026-08-05" },
  { n: "5", company: "Zeta", role: "Platform Engineer", score: "4.8/5", status: "Evaluated", date: "2026-08-04" },
];

test("default order: score descending, NaN scores last", () => {
  const out = orderApplications(apps, {});
  assert.deepEqual(out.map((a) => a.n), ["5", "1", "2", "4", "3"]);
});

test("explicit default shape matches the omitted one", () => {
  const a = orderApplications(apps, {});
  const b = orderApplications(apps, { tab: "ALL", sortKey: "score", dir: -1, min: null, q: "" });
  assert.deepEqual(a, b);
});

test("INBOX yields an empty list (the triage queue is not the tracker)", () => {
  assert.deepEqual(orderApplications(apps, { tab: "INBOX" }), []);
});

test("tab filters by canonical status", () => {
  const out = orderApplications(apps, { tab: "APPLIED" });
  assert.deepEqual(out.map((a) => a.n), ["2", "3"]);
});

test("min filters numeric scores >= threshold (NaN and below dropped)", () => {
  const out = orderApplications(apps, { min: 3 });
  assert.deepEqual(out.map((a) => a.n), ["5", "1", "2"]);
  // NaN score ("") has no number → excluded
  assert.ok(!out.some((a) => a.n === "3"));
});

test("q searches company + role case-insensitively", () => {
  // 1,3,4,5 all carry "engineer" in the role; 2 does not → filtered, then the
  // default score-descending order applies.
  const out = orderApplications(apps, { q: "engineer" });
  assert.deepEqual(out.map((a) => a.n), ["5", "1", "4", "3"]);
  // matches the company too
  const acme = orderApplications(apps, { q: "acme" });
  assert.deepEqual(acme.map((a) => a.n), ["1", "3"]);
});

test("company/role/date sort alphabetically / chronologically (dir=1)", () => {
  assert.deepEqual(orderApplications(apps, { sortKey: "company", dir: 1 }).map((a) => a.n), ["1", "3", "2", "4", "5"]);
  assert.deepEqual(orderApplications(apps, { sortKey: "role", dir: 1 }).map((a) => a.n), ["2", "3", "4", "5", "1"]);
  assert.deepEqual(orderApplications(apps, { sortKey: "date", dir: 1 }).map((a) => a.n), ["1", "3", "2", "5", "4"]);
});

test("dir flips the order", () => {
  assert.deepEqual(orderApplications(apps, { sortKey: "date", dir: 1 }).map((a) => a.n), ["1", "3", "2", "5", "4"]);
  // ascending score puts NaN (no numeric score) FIRST
  assert.deepEqual(orderApplications(apps, { sortKey: "score", dir: 1 }).map((a) => a.n), ["3", "4", "2", "1", "5"]);
});

test("status sorts as a plain string (dir=1)", () => {
  const out = orderApplications(apps, { sortKey: "status", dir: 1 }).map((a) => a.n);
  // Applied < Evaluated < Interview lexicographically
  assert.deepEqual(out, ["2", "3", "1", "5", "4"]);
});

test("buildContextQuery always serializes tab, elides only tracker-defaults", () => {
  // The list page's no-param default is INBOX (triage); the tracker table's
  // default is tab=ALL — so tab must ALWAYS be explicit or a round-trip would
  // fall back to INBOX (#back-link-context regression).
  assert.equal(buildContextQuery({}), "?tab=ALL");
  assert.equal(buildContextQuery({ tab: "ALL", sortKey: "score", dir: -1, min: null, q: "" }), "?tab=ALL");
  assert.equal(buildContextQuery({ tab: "APPLIED" }), "?tab=APPLIED");
  assert.equal(buildContextQuery({ tab: "ALL", min: 4 }), "?tab=ALL&min=4");
  assert.equal(buildContextQuery({ sortKey: "company", dir: 1, q: "acme" }), "?tab=ALL&sort=company&dir=1&q=acme");
  assert.equal(buildContextQuery({ tab: "APPLIED", min: 3, sortKey: "date", dir: 1, q: " eng " }), "?tab=APPLIED&min=3&sort=date&dir=1&q=eng");
});

// ── countSelectedOffView: the batch pill names the part of its batch that the
// filter hides (the deliberate opposite of the explore results bar, whose label
// promises the visible set and therefore must be narrowed to it) ───────────────

test("a filter that hides part of the batch is counted, not silently ignored", () => {
  const selected = new Set(["1", "2", "3", "4", "5"]);
  const applied = orderApplications(apps, { tab: "APPLIED" }); // rows 2, 3
  assert.equal(countSelectedOffView(apps, applied, selected), 3, "1/4/5 sit outside the APPLIED tab");
  assert.equal(countSelectedOffView(apps, orderApplications(apps, {}), selected), 0, "no filter hides nothing");
});

test("the search box is a filter too", () => {
  const selected = new Set(["1", "5"]);
  assert.equal(countSelectedOffView(apps, orderApplications(apps, { q: "acme" }), selected), 1, "5 is hidden by the search");
});

test("narrowing the count instead would have dropped the hidden half — so it is not narrowed", () => {
  // The invariant the pill depends on: selected.size is what the batch will do
  // (reevaluateSelected fires over ALL of `selected`), and the off-view count is
  // the part of it the user cannot see. selected.size - offView === rows on screen.
  const selected = new Set(["1", "2", "3"]);
  const visible = orderApplications(apps, { min: 4 }); // rows 1, 5
  const off = countSelectedOffView(apps, visible, selected);
  const onScreen = visible.filter((r) => selected.has(r.n)).length;
  assert.equal(off + onScreen, selected.size, "off-view + on-view must account for the whole batch");
});

test("a key left over from a finished refresh is not reported as hidden", () => {
  // router.refresh() can retire a row the user had checked; it is gone, not
  // "outside the filter" — counting it would promise work that cannot happen.
  const selected = new Set(["1", "999"]);
  assert.equal(countSelectedOffView(apps, orderApplications(apps, {}), selected), 0);
});

test("an empty selection is a no-op", () => {
  assert.equal(countSelectedOffView(apps, [], new Set()), 0);
});

test("buildContextQuery round-trips: query → ctx reproduces the same list", () => {
  const ctx = { tab: "APPLIED", min: 3, sortKey: "company", dir: 1, q: "data" };
  const qs = buildContextQuery(ctx);
  assert.equal(qs, "?tab=APPLIED&min=3&sort=company&dir=1&q=data");
  const reparsed = {
    tab: "APPLIED",
    min: parseFloat("3"),
    sortKey: "company",
    dir: 1,
    q: "data",
  };
  assert.deepEqual(orderApplications(apps, reparsed), orderApplications(apps, ctx));
});
