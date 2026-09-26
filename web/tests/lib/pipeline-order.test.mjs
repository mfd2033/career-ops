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

// ── salary: 报告薪资排序键（ADR-0037）───────────────────────────────────────
// 区间中位值排序；未披露**恒沉底**（升降序都在最后，比较器不乘 dir）；平手回退
// score 降序 → 报告号降序。

const salaried = [
  {
    n: "20",
    company: "A",
    role: "x",
    score: "4.0/5",
    status: "Evaluated",
    date: "2026-08-01",
    reportSalary: { text: "10-15K", range: { minK: 10, maxK: 15, medianK: 12.5 } },
  },
  {
    n: "21",
    company: "B",
    role: "x",
    score: "3.0/5",
    status: "Evaluated",
    date: "2026-08-02",
    reportSalary: { text: "25-30K", range: { minK: 25, maxK: 30, medianK: 27.5 } },
  },
  {
    n: "22",
    company: "C",
    role: "x",
    score: "4.5/5",
    status: "Evaluated",
    date: "2026-08-03",
    reportSalary: { text: "not stated", range: null },
  },
  // 老行 / 无报告：整个字段缺失，与 range: null 同等对待
  { n: "23", company: "D", role: "x", score: "2.0/5", status: "Evaluated", date: "2026-08-04" },
];

test("salary: 区间中位值降序，未披露沉底", () => {
  assert.deepEqual(orderApplications(salaried, { sortKey: "salary" }).map((a) => a.n), ["21", "20", "22", "23"]);
});

test("salary: 升序时未披露仍在最后——这是有意偏离 score/duration 惯例的回归点", () => {
  assert.deepEqual(orderApplications(salaried, { sortKey: "salary", dir: 1 }).map((a) => a.n), ["20", "21", "22", "23"]);
});

test("salary: 未披露块内部按 score 降序（平手回退），与方向无关", () => {
  const desc = orderApplications(salaried, { sortKey: "salary" }).slice(2).map((a) => a.n);
  const asc = orderApplications(salaried, { sortKey: "salary", dir: 1 }).slice(2).map((a) => a.n);
  assert.deepEqual(desc, ["22", "23"], "22 是 4.5/5，23 是 2.0/5");
  assert.deepEqual(asc, desc);
});

test("salary: 中位值平手回退 score 降序", () => {
  const tie = [
    { n: "30", score: "3.0/5", reportSalary: { text: "10-15K", range: { minK: 10, maxK: 15, medianK: 12.5 } } },
    { n: "31", score: "4.0/5", reportSalary: { text: "12.5K", range: { minK: 12.5, maxK: 12.5, medianK: 12.5 } } },
  ];
  assert.deepEqual(orderApplications(tie, { sortKey: "salary" }).map((a) => a.n), ["31", "30"]);
});

test("salary: 中位值与 score 都平手回退报告号降序，且不随方向翻转", () => {
  const mk = (n) => ({ n, score: "4.0/5", reportSalary: { text: "10-15K", range: { minK: 10, maxK: 15, medianK: 12.5 } } });
  const tie = [mk("30"), mk("32"), mk("31")];
  assert.deepEqual(orderApplications(tie, { sortKey: "salary" }).map((a) => a.n), ["32", "31", "30"]);
  assert.deepEqual(orderApplications(tie, { sortKey: "salary", dir: 1 }).map((a) => a.n), ["32", "31", "30"]);
});

test("salary: 序列化进 URL 上下文（列表与报告页导航共用一个键）", () => {
  assert.equal(buildContextQuery({ tab: "ALL", sortKey: "salary", dir: 1 }), "?tab=ALL&sort=salary&dir=1");
  assert.equal(buildContextQuery({ tab: "ALL", sortKey: "salary", dir: -1 }), "?tab=ALL&sort=salary");
});

// ── checkup: 体检分数排序键（ADR-0064）──────────────────────────────────────
// 排序值 = 页面级 join 的最近一次 star（checkupStar）；未体检**恒沉底**
// （升降序都在最后，比较器不乘 dir，ADR-0037 决议 6 同一口径）；平手回退
// score 降序 → 报告号降序。

const checkuped = [
  { n: "40", company: "A", role: "x", score: "4.0/5", status: "Evaluated", date: "2026-08-01", checkupStar: 3.0 },
  { n: "41", company: "B", role: "x", score: "3.0/5", status: "Evaluated", date: "2026-08-02", checkupStar: 4.5 },
  { n: "42", company: "C", role: "x", score: "4.5/5", status: "Evaluated", date: "2026-08-03", checkupStar: 1.5 },
  // 未体检：字段缺失与显式 null 同等对待（台账里 `?` 行/无记录都走这里）
  { n: "43", company: "D", role: "x", score: "2.0/5", status: "Evaluated", date: "2026-08-04", checkupStar: null },
  { n: "44", company: "E", role: "x", score: "3.5/5", status: "Evaluated", date: "2026-08-05" },
];

test("checkup: 降序高星在前，未体检沉底", () => {
  assert.deepEqual(orderApplications(checkuped, { sortKey: "checkup" }).map((a) => a.n), ["41", "40", "42", "44", "43"]);
});

test("checkup: 升序时未体检仍在最后——恒沉底不随方向翻转（ADR-0064 决议 6）", () => {
  assert.deepEqual(orderApplications(checkuped, { sortKey: "checkup", dir: 1 }).map((a) => a.n), ["42", "40", "41", "44", "43"]);
});

test("checkup: 未体检块内部按 score 降序（平手回退），与方向无关", () => {
  const desc = orderApplications(checkuped, { sortKey: "checkup" }).slice(3).map((a) => a.n);
  const asc = orderApplications(checkuped, { sortKey: "checkup", dir: 1 }).slice(3).map((a) => a.n);
  assert.deepEqual(desc, ["44", "43"], "44 是 3.5/5，43 是 2.0/5");
  assert.deepEqual(asc, desc);
});

test("checkup: star 平手回退 score 降序，再平手回退报告号降序且不为所动于方向", () => {
  const tie = [
    { n: "50", score: "3.0/5", checkupStar: 4.0 },
    { n: "51", score: "4.0/5", checkupStar: 4.0 },
    { n: "52", score: "4.0/5", checkupStar: 4.0 },
  ];
  assert.deepEqual(orderApplications(tie, { sortKey: "checkup" }).map((a) => a.n), ["52", "51", "50"]);
  assert.deepEqual(orderApplications(tie, { sortKey: "checkup", dir: 1 }).map((a) => a.n), ["52", "51", "50"]);
});

test("checkup: 台账缺失/整列无值时顺序仍确定——退化为 score 降序回退链", () => {
  assert.deepEqual(orderApplications(apps, { sortKey: "checkup" }).map((a) => a.n), ["5", "1", "2", "4", "3"]);
});

test("checkup: 序列化进 URL 上下文（列表与报告页导航共用一个键）", () => {
  assert.equal(buildContextQuery({ tab: "ALL", sortKey: "checkup", dir: 1 }), "?tab=ALL&sort=checkup&dir=1");
  assert.equal(buildContextQuery({ tab: "ALL", sortKey: "checkup", dir: -1 }), "?tab=ALL&sort=checkup");
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

// ── navNeighbors × checkup：列表所见顺序 = 导航走到顺序（ADR-0064 决议 8）────
// 详情页只在 sort=checkup 时 join checkupStar（withCheckupStars），喂进来的就是
// 下面这种已 join 的行——两侧同一个比较器，这些用例同时锁住两端的复现。

test("navNeighbors: checkup 排序下 prev/next 与列表同序，上下文往返不变", () => {
  const nav = navNeighbors(checkuped, { sortKey: "checkup" }, "40");
  // 降序列是 41,40,42,44,43 —— 40  sits second。
  assert.equal(nav.prev.n, "41");
  assert.equal(nav.next.n, "42");
  assert.equal(nav.position, 2);
  assert.equal(nav.total, 5);
  assert.equal(buildContextQuery(nav.context), "?tab=ALL&sort=checkup");
});

test("navNeighbors: 恒沉底行也能作为出发点——从尾部未知行往回走", () => {
  // 43（未体检，尾）：prev 是未体检块内的 44（score 回退序），next 到底。
  const tail = navNeighbors(checkuped, { sortKey: "checkup" }, "43");
  assert.equal(tail.position, 5);
  assert.equal(tail.prev.n, "44");
  assert.equal(tail.next, null);
  // 44（未知块头部）：前一个已是已体检行的尾巴 42，边界不串块。
  const lastKnown = navNeighbors(checkuped, { sortKey: "checkup" }, "44");
  assert.equal(lastKnown.prev.n, "42");
  assert.equal(lastKnown.next.n, "43");
});

test("navNeighbors: checkup 升序同样不漂；未体检行离开 tab 后插回沉底块槽位", () => {
  const asc = navNeighbors(checkuped, { sortKey: "checkup", dir: 1 }, "40");
  // 升序：42,40,41,44,43。
  assert.equal(asc.prev.n, "42");
  assert.equal(asc.next.n, "41");
  // 行 45（未体检、刚被改状态离开 EVALUATED）升序下也插回未知块而非浮顶：
  // 若是 score/duration 的 -Infinity 惯例，(-Inf - 1.5) * 1 会让 5.0 分的它抢在
  // 所有已体检行前面——恒沉底分支不乘 dir，正是为了堵住这个误读。
  const left = [...checkuped.map((r) => ({ ...r, status: "Evaluated" })), 
    { n: "45", company: "F", role: "x", score: "5.0/5", status: "Applied", date: "2026-08-06", checkupStar: null }];
  const nav = navNeighbors(left, { tab: "EVALUATED", sortKey: "checkup", dir: 1 }, "45");
  assert.equal(nav.total, 5, "离开的是 EVALUATED tab，导航留在其中");
  assert.equal(nav.position, 4, "未知恒沉底：5.0 匹配分也不能让它浮顶");
  assert.equal(nav.prev.n, "41", "升序已体检块尾是 4.5 的 41");
  assert.equal(nav.next.n, "44", "未知块内按 score 降序回退插位：45(5.0) 在 44(3.5) 前");
});
