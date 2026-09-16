// filtered-fold.test.mjs — the read-only 「已过滤」 fold (ADR-0029 决议 4/5).
//
// The fold is the user-facing half of the collection gate: the ledger answers
// "which search brought this in", the fold answers "did the gate eat something I
// wanted" — and the two must not disagree. Decision 5 makes the fold READ-ONLY
// for exactly that reason: a rescue path would leave the ledger holding a
// skipped_title row for a posting that did reach the inbox, and then neither
// record could be trusted for the replay.
//
// It is a React surface, so like the wiring in browser-scan.test.mjs these are
// source assertions on the parts that carry the decisions: where the list comes
// from, and what the fold deliberately does NOT offer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const flat = (rel) => readFileSync(join(here, "../../src", rel), "utf8").replace(/\s+/g, " ");

const PROVIDER = "components/explore/explore-provider.tsx";
const LIST = "components/explore/results-list.tsx";
const I18N = "lib/i18n/clusters/explore.ts";

test("both drivers park their rejects in provider state, not only in a local", () => {
  const src = flat(PROVIDER);
  assert.match(src, /const \[folded, setFolded\] = useState<DiscoveredOffer\[\]>\(\[\]\)/, "the fold needs component state — a callback-local array dies with the callback");
  assert.match(src, /setFolded\(gated\.dropped\)/, "the extension path must publish its rejects");
  assert.match(src, /setFolded\(foldedAcc\)/, "the bsk path must publish the folded batch it received");
  assert.match(src, /folded: DiscoveredOffer\[\]/, "and expose it on the context, or no component can read it");
  // Every entry into a results phase must clear it, or a stale batch from the
  // previous hunt shows up under the new one's header.
  const resets = (src.match(/setFolded\(\[\]\)/g) ?? []).length;
  assert.ok(resets >= 4, `expected setFolded([]) on each discovery entry + reset (found ${resets})`);
});

test("the fold renders the rejects and stays read-only", () => {
  const src = readFileSync(join(here, "../../src", LIST), "utf8");
  const flatSrc = src.replace(/\s+/g, " ");
  assert.match(flatSrc, /const \{ [^}]*folded[^}]*\} = useExplore\(\)/, "ResultsList must read the fold list off the context");
  assert.match(flatSrc, /<FilteredFold offers=\{folded\} \/>/, "and render it");

  const start = src.indexOf("function FilteredFold(");
  assert.ok(start >= 0, "FilteredFold is gone — the 已过滤 fold no longer renders");
  const end = src.indexOf("export function ResultsList(");
  assert.ok(end > start, "could not bound the FilteredFold body");
  const body = src.slice(start, end).replace(/\s+/g, " ");

  for (const forbidden of ["onToggleSelect", "addToPipeline", "DiscoveryCard", "selected"]) {
    assert.ok(
      !body.includes(forbidden),
      `the fold must stay read-only (found "${forbidden}"): a rescue path would leave the ledger holding a skipped_title row for a posting that reached the inbox, and neither record could then be trusted (决议 5)`,
    );
  }
  assert.match(body, /target="_blank"/, "each reject opens the original posting in a new tab");
  assert.match(body, /\^https\?:\\\/\\\//, "an unparseable URL degrades to plain text instead of a dead link");
  assert.match(body, /if \(offers\.length === 0\) return null/, "N=0 must render nothing at all");
  assert.match(body, /useState\(false\)/, "and it must default to collapsed");
});

test("the fold is labelled in both locales", () => {
  const src = readFileSync(join(here, "../../src", I18N), "utf8");
  for (const key of ["explore.results.filteredFold", "explore.results.filteredFoldHint"]) {
    const hits = (src.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) ?? []).length;
    assert.equal(hits, 2, `${key} must exist in both locales (found ${hits}) — an English-only key renders as the raw id in zh, which is how a missing translation ships unnoticed`);
  }
});
