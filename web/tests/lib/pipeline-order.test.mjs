// Tests for the shared pipeline ordering/filtering used by BOTH the tracker
// table (pipeline-view.tsx) and the report detail page's prev/next navigation
// (pipeline/[id]/page.tsx). The detail page must reproduce the list view's
// filter+sort context exactly, so this module is the one source of truth and
// the two consumers must never drift — these tests lock that contract.
//
// Run:  node --test tests/lib/pipeline-order.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { orderApplications, buildContextQuery, countSelectedOffView, navNeighbors } from "../../src/lib/pipeline-order.mjs";

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

// ── navNeighbors: the report detail page's prev/next (ADR-0036) ──────────────
// The detail page used to compute `index = ordered.findIndex(a => a.n === id)`
// and, when that missed, silently fall back to the ALL rows. Two failures came
// out of that: a row that just left the tab the user was walking (a status
// change does exactly that) kicked the navigation into the WHOLE tracker, and a
// duplicated tracker number made "next" point at itself. navNeighbors owns both.

test("navNeighbors: normal case reads prev/next/position/total from the context", () => {
  const nav = navNeighbors(apps, { tab: "ALL" }, "2");
  // ALL order is 5,1,2,4,3 — row 2 sits third.
  assert.equal(nav.prev.n, "1");
  assert.equal(nav.next.n, "4");
  assert.equal(nav.position, 3);
  assert.equal(nav.total, 5);
  assert.equal(nav.context.tab, "ALL");
});

test("navNeighbors: a row that left the tab keeps the tab context (no silent fallback to ALL)", () => {
  // Row 1 is Evaluated; the user is walking the APPLIED tab (rows 2, 3) and just
  // changed row 1 out of it. Navigating must stay in APPLIED, not jump to ALL.
  const nav = navNeighbors(apps, { tab: "APPLIED" }, "1");
  assert.equal(nav.context.tab, "APPLIED", "the fallback must not swap the context");
  assert.equal(nav.total, 2, "total is the tab the user is walking, not the whole tracker");
  // Insertion slot: 4.2 sorts above the tab's 3.1 → it left from slot 1.
  assert.equal(nav.position, 1);
  assert.equal(nav.prev, null);
  assert.equal(nav.next.n, "2", "next is the tab's first row, not the ALL-list neighbour");
});

test("navNeighbors: a row that left a score-filtered view inserts at its filtered slot", () => {
  // min=3 drops row 4 (2.4) and row 3 (no score) → list 5,1,2. Row 4 left from the tail.
  const nav = navNeighbors(apps, { tab: "ALL", min: 3 }, "4");
  assert.equal(nav.total, 3);
  assert.equal(nav.position, 3);
  assert.equal(nav.prev.n, "2");
  assert.equal(nav.next, null);
});

test("navNeighbors: INBOX keeps the historical fallback (the triage queue is not the tracker table)", () => {
  const nav = navNeighbors(apps, { tab: "INBOX" }, "2");
  assert.equal(nav.context.tab, "ALL");
  assert.equal(nav.total, 5);
  assert.equal(nav.position, 3);
});

test("navNeighbors: an id the tracker does not hold falls back to ALL, and yields no nav when absent there too", () => {
  const presentElsewhere = navNeighbors(apps, { tab: "APPLIED" }, "5"); // 5 is Evaluated → in ALL
  assert.equal(presentElsewhere.context.tab, "APPLIED", "still a real row: stay in the walked tab");
  assert.equal(presentElsewhere.total, 2);
  const gone = navNeighbors(apps, { tab: "ALL" }, "99");
  assert.equal(gone.position, null);
  assert.equal(gone.prev, null);
  assert.equal(gone.next, null);
  assert.equal(gone.context.tab, "ALL");
});

test("navNeighbors: a duplicated tracker number is counted once and never links back to itself", () => {
  const dup = [
    { n: "432", company: "X", role: "PM", score: "3.0/5", status: "Evaluated" }, // raw 0
    { n: "362", company: "Y", role: "PM", score: "3.0/5", status: "Evaluated" }, // raw 1
    { n: "432", company: "X", role: "PM", score: "3.0/5", status: "Evaluated" }, // raw 2 — the duplicate
    { n: "590", company: "Z", role: "PM", score: "2.0/5", status: "Evaluated" }, // raw 3
  ];
  assert.equal(navNeighbors(dup, {}, "432").total, 3, "two rows, one navigable report");
  // The row before the duplicate used to link 下一个 back at /pipeline/432.
  const before = navNeighbors(dup, {}, "362");
  assert.equal(before.position, 2);
  assert.equal(before.prev.n, "432");
  assert.equal(before.next.n, "590", "下一个 advances past the duplicate instead of looping back");
  assert.equal(navNeighbors(dup, {}, "432").next.n, "362", "lookup keeps the first copy's neighbours");
});

test("navNeighbors: insertion inside a score tie reproduces the stable (raw) order", () => {
  const tieFirst = [
    { n: "1", company: "A", role: "PM", score: "4.0/5", status: "Applied" },
    { n: "2", company: "B", role: "PM", score: "4.0/5", status: "Evaluated" },
    { n: "3", company: "C", role: "PM", score: "4.0/5", status: "Evaluated" },
  ];
  // Row 1 left the EVALUATED tab from slot 1 (it sorts before row 2 among equals).
  const head = navNeighbors(tieFirst, { tab: "EVALUATED" }, "1");
  assert.equal(head.position, 1);
  assert.equal(head.next.n, "2");

  // The mirror case: a row whose raw position is after the tie block sits at the
  // tail — position clamps to the list length instead of overshooting it.
  const tieLast = [
    { n: "2", company: "B", role: "PM", score: "4.0/5", status: "Evaluated" },
    { n: "3", company: "C", role: "PM", score: "4.0/5", status: "Evaluated" },
    { n: "1", company: "A", role: "PM", score: "4.0/5", status: "Applied" },
  ];
  const tail = navNeighbors(tieLast, { tab: "EVALUATED" }, "1");
  assert.equal(tail.position, 2);
  assert.equal(tail.prev.n, "3");
  assert.equal(tail.next, null);
});

test("navNeighbors: an id excluded by min+q still inserts at its slot inside the filtered list", () => {
  const scoped = [
    { n: "1", company: "Acme", role: "Engineer", score: "4.5/5", status: "Evaluated" }, // kept
    { n: "2", company: "Beta", role: "Designer", score: "4.4/5", status: "Evaluated" }, // dropped by q
    { n: "3", company: "Gamma", role: "Engineer", score: "3.2/5", status: "Evaluated" }, // kept
    { n: "4", company: "Delta", role: "Engineer", score: "2.0/5", status: "Evaluated" }, // dropped by min
  ];
  const ctx = { tab: "ALL", min: 3, q: "engineer" };
  // Kept: 1 (4.5) then 3 (3.2).
  assert.deepEqual(orderApplications(scoped, ctx).map((r) => r.n), ["1", "3"]);

  // #2 was search-filtered out from between the two survivors.
  const mid = navNeighbors(scoped, ctx, "2");
  assert.equal(mid.total, 2);
  assert.equal(mid.position, 2);
  assert.equal(mid.prev.n, "1");
  assert.equal(mid.next.n, "3");
  assert.equal(mid.context.min, 3);
  assert.equal(mid.context.q, "engineer");

  // #4 was score-filtered out from the tail.
  const tail = navNeighbors(scoped, ctx, "4");
  assert.equal(tail.position, 2);
  assert.equal(tail.prev.n, "3");
  assert.equal(tail.next, null);
});

test("navNeighbors: buildContextQuery of the returned context round-trips the walked view", () => {
  const nav = navNeighbors(apps, { tab: "APPLIED", sortKey: "company", dir: 1 }, "1");
  assert.equal(buildContextQuery(nav.context), "?tab=APPLIED&sort=company&dir=1");
});
