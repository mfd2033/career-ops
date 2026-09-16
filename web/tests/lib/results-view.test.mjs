// results-view.test.mjs — the bulk-confirm bar describes the rows on screen.
//
// Regression: 「全选可加入 (N)」 derived N from the WHOLE result set while the rows
// below came from the tab+keyword filtered list. After a scan, typing one keyword
// left three rows on screen and the button still promising five — and clicking it
// ticked (and confirmed) rows the user could not see. That confirm is a real write
// to pipeline.md, so the mismatch was not cosmetic: a filtered review silently
// added postings that were never reviewed.
//
// Two halves, because either alone would pass on broken code:
//   1. the derivation itself — a keyword/tab narrows the countable rows exactly
//      as it narrows the rendered ones;
//   2. the wiring — the counts and the select/confirm actions read THAT
//      derivation (a re-derived copy in the component would keep passing the
//      first half while the button counted something else).
//
// Run:  node --test tests/lib/results-view.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isSelectable, inResultTab, resultTabOf, visibleOffers } from "../../src/lib/results-view.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const LIST = "components/explore/results-list.tsx";
const read = (rel) => readFileSync(join(here, "../../src", rel), "utf8");
const flat = (rel) => read(rel).replace(/\s+/g, " ");

const mk = (url, title, company, extra = {}) => ({ url, title, company, postedAt: "2026-09-10", ...extra });

// The shape the /explore snapshot produces: five addable rows in the default
// 「新增」 tab, none of them already confirmed in this session.
const offers = [
  mk("https://x/1", "前端工程师", "甲公司"),
  mk("https://x/2", "高级前端工程师", "乙公司"),
  mk("https://x/3", "后端工程师", "丙公司"),
  mk("https://x/4", "算法工程师", "丁公司"),
  mk("https://x/5", "前端实习生", "戊公司"),
];
const none = new Set();
const countable = (tab, query, added = none) => visibleOffers(offers, tab, query).filter((o) => isSelectable(o, added));

// ── 1. the derivation ────────────────────────────────────────────────────────

test("a keyword narrows the countable rows exactly as it narrows the rendered ones", () => {
  const before = visibleOffers(offers, "new", "");
  assert.equal(before.length, 5, "no keyword → the whole tab is on screen");
  assert.equal(countable("new", "").length, 5, "…and all of it is countable");

  const after = visibleOffers(offers, "new", "前端");
  assert.equal(after.length, 3, "the keyword narrows the rendered rows");
  // THE regression: 3 rows on screen must mean 3 rows countable, not the whole set.
  assert.equal(countable("new", "前端").length, 3, "the count must follow the rows — the bar may not promise rows that are not on screen");
});

test("the keyword matches company as well as title, case-insensitively", () => {
  assert.equal(visibleOffers(offers, "new", "丁公司").length, 1, "company match");
  assert.deepEqual(
    visibleOffers([mk("https://x/6", "AI Engineer", "Acme")], "new", "ai engineer").map((o) => o.url),
    ["https://x/6"],
    "title match folds case",
  );
  assert.equal(visibleOffers(offers, "new", "  ").length, 5, "whitespace-only is not a keyword");
});

test("the tab narrows it too, and 「全部」 is the fallback over every group", () => {
  const mixed = [
    mk("https://x/1", "A", "甲"),
    mk("https://x/2", "B", "乙", { inPipeline: true }),
    mk("https://x/3", "C", "丙", { evaluatedN: "#900" }),
  ];
  assert.equal(inResultTab("all", mixed[0]), true, "「全部」 covers every group");
  assert.equal(resultTabOf(mixed[1]), "pipeline");
  assert.equal(resultTabOf(mixed[2]), "evaluated", "evaluated wins: it is the narrower fact (evaluated ⊆ inPipeline)");
  assert.deepEqual(visibleOffers(mixed, "evaluated", "").map((o) => o.url), ["https://x/3"]);
  // Nothing on screen in a non-addable tab → the bar has nothing to promise.
  assert.equal(visibleOffers(mixed, "evaluated", "").filter((o) => isSelectable(o, none)).length, 0);
  assert.equal(visibleOffers(mixed, "all", "").filter((o) => isSelectable(o, none)).length, 1);
});

test("a row already in the pipeline, already evaluated, or confirmed this session is not countable", () => {
  assert.equal(isSelectable(mk("https://x/1", "A", "甲"), none), true);
  assert.equal(isSelectable(mk("https://x/1", "A", "甲", { inPipeline: true }), none), false, "already in the pipeline");
  assert.equal(isSelectable(mk("https://x/1", "A", "甲", { evaluatedN: "#1" }), none), false, "already evaluated implies a pipeline row");
  assert.equal(isSelectable(mk("https://x/1", "A", "甲"), new Set(["https://x/1"])), false, "confirmed earlier in this session");
});

// ── 2. the wiring ────────────────────────────────────────────────────────────

test("the bar counts, ticks and confirms the visible derivation — not a second copy", () => {
  const src = flat(LIST);
  assert.match(
    src,
    /import \{ isSelectable, resultTabOf, visibleOffers \} from "@\/lib\/results-view\.mjs"/,
    "the derivation must come from the shared module",
  );
  assert.match(
    src,
    /const visibleAddable = useMemo\(\(\) => view\.filter\(\(o\) => isSelectable\(o, added\)\), \[view, added\]\)/,
    "the bar's set is derived from `view` (tab + keyword), which is what is rendered — deriving it from `offers` instead is exactly the bug",
  );
  assert.match(
    src,
    /t\("explore\.results\.selectAll", \{ n: visibleAddable\.length \}\)/,
    "the 「全选可加入 (N)」 number is the visible, selectable count",
  );
  assert.match(
    src,
    /for \(const o of visibleAddable\) \{/,
    "select-all / clear act on the visible rows only, so the button can never tick a row the user cannot see",
  );
  assert.match(src, /selectable=\{isSelectable\(o, added\)\}/, "each rendered card's box asks the same predicate");
  assert.match(src, /const selectedAddable = visibleAddable\.filter\(\(o\) => selected\.has\(o\.url\)\)/, "confirm counts the visible selection");

  // The pre-fix shape must not come back: the bar reading the whole result set.
  assert.ok(
    !/explore\.results\.selectAll", \{ n: addable\.length \}/.test(src),
    "the bar must not fall back to the whole-set `addable` count",
  );
});

test("the tab counts still look at the whole result set (a deliberate contrast, not an oversight)", () => {
  const src = read(LIST);
  const start = src.indexOf("const counts = useMemo(");
  assert.ok(start >= 0, "the tab counts are gone");
  const end = src.indexOf("const view = useMemo(");
  assert.ok(end > start, "could not bound the counts memo");
  const body = src.slice(start, end).replace(/\s+/g, " ");

  assert.match(body, /all: offers\.length, new: 0, pipeline: 0, evaluated: 0/, "tab badges count the full set");
  assert.match(body, /for \(const o of offers\) c\[resultTabOf\(o\)\] \+= 1/, "…over every offer, not over the filtered list");
  // The contrast is deliberate (pipeline-page behaviour): only the bulk bar is
  // scoped to the keyword. Widening the fix into the badges would be a silent
  // behaviour change, so pin the boundary.
  for (const forbidden of ["q", "visibleOffers", "view"]) {
    assert.ok(!body.includes(forbidden), `the tab badges must not be narrowed by the filter box (found "${forbidden}")`);
  }
});
