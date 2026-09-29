// The Explorer's initial-filters decision hinges on one question: does the URL
// carry a set of FILTER params, or only an ACTION param? A filter param means
// "this URL is a complete, shareable search" (decode it with paramsToFilters).
// An action param — the onboarding hand-off's ?run=1 — means nothing about
// filters, so the server seed (seeded from the user's portals.yml /
// profile.yml) must survive.
//
// The defect this locks down: the decision used to be "URL has ANY param", so
// ?run=1 decoded to all-empty filters. serializePortals then wrote an
// annotations-only ephemeral portals.yml, which js-yaml reads as an EMPTY
// document — scan-ats-full.mjs threw "expected a document, but the input is
// empty", exited before printing its JSON, and the page reported "无法完成搜索。
// The scanner returned no readable output."
//
// Run:  node --test tests/lib/explore-params.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FILTER_PARAM_KEYS, carriesFilterParams, shouldAutoRunOnHandoff } from "../../src/lib/explore-params.mjs";

const sp = (qs) => new URLSearchParams(qs);

test("the onboarding hand-off (?run=1) carries NO filter params", () => {
  assert.equal(carriesFilterParams(sp("run=1")), false);
});

test("an empty URL carries no filter params", () => {
  assert.equal(carriesFilterParams(sp("")), false);
});

test("an unrelated action param alone is still not a filter set", () => {
  assert.equal(carriesFilterParams(sp("view=fresh")), false);
});

test("every filter param filtersToParams can encode counts as one", () => {
  for (const k of FILTER_PARAM_KEYS) {
    assert.equal(carriesFilterParams(sp(`${k}=x`)), true, `param ${k} must count`);
  }
});

test("a filter param next to ?run=1 still counts (URL wins over seed)", () => {
  assert.equal(carriesFilterParams(sp("run=1&q=AI")), true);
});

// Drift guard: FILTER_PARAM_KEYS must equal the key set filtersToParams()
// actually encodes — that function's output IS "a complete shareable search",
// so anything it can emit must classify as a filter param, and nothing else
// may. Source-level because explore.ts is TS and cannot load under node --test
// (the same reason portals-serialize.mjs was extracted from portals.ts).
test("FILTER_PARAM_KEYS matches what filtersToParams actually encodes", () => {
  const src = fs.readFileSync(new URL("../../src/lib/explore.ts", import.meta.url), "utf8");
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const start = stripped.indexOf("export function filtersToParams");
  assert.notEqual(start, -1, "filtersToParams not found in explore.ts");
  const rest = stripped.slice(start);
  const end = rest.indexOf("\n}");
  const fn = end === -1 ? rest : rest.slice(0, end);
  const encoded = [...fn.matchAll(/sp\.set\(\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(encoded, [...FILTER_PARAM_KEYS].sort());
});

// ── ?run=1 hand-off vs the configured scan sources (配置页「扫描方式」) ──
//
// The pipeline's empty-inbox CTA and the CV-ingest WOW both land on
// /explore?run=1. Whether that auto-fires the sweep must follow the user's
// configured sources: ATS is unattended (HTTP only) so it may run on
// arrival; BSK collection drives the user's logged-in browser and needs
// keywords/city chosen on the form first, so a BSK-only config must stop at
// the form instead of firing a scan the user did not configure.

test("ATS configured → the hand-off auto-runs", () => {
  assert.equal(shouldAutoRunOnHandoff(["ats"]), true);
});

test("BSK-only configured → the hand-off does NOT auto-run", () => {
  assert.equal(shouldAutoRunOnHandoff(["bsk"]), false);
});

test("ATS enabled alongside BSK still auto-runs (both are configured)", () => {
  assert.equal(shouldAutoRunOnHandoff(["ats", "bsk"]), true);
  assert.equal(shouldAutoRunOnHandoff(["bsk", "ats"]), true);
});

test("a missing/garbled source list never auto-runs", () => {
  assert.equal(shouldAutoRunOnHandoff([]), false);
  assert.equal(shouldAutoRunOnHandoff(undefined), false);
  assert.equal(shouldAutoRunOnHandoff(null), false);
  assert.equal(shouldAutoRunOnHandoff("ats"), false);
});
