// gate-panel.test.mjs — the collection gate's rule card, now the place you EDIT
// the word list (gate-visibility 工单 01 只读版 + 工单 03 编辑回路).
//
// The card exists because the gate is invisible: one real hunt collected 246
// postings, the gate kept 161, and 34 of those 161 carried neither 「解决」 nor
// 「架构」 in the title. That is the documented semantics — the search box decides
// what the sites return, the word list decides what stays — but nothing on screen
// said so, so it read as a bug.
//
// The editor exists because the old answer to "the gate ate something I wanted"
// was: close the page, hand-edit portals.yml, re-scan. Nobody does that, which is
// why the word list had not moved in a year. So these assertions pin the four
// things that make the loop trustworthy rather than merely present:
//
//   1. ONE matching implementation — the trial judges with the same compiled
//      filter the gate does. A re-derived rule here would still pass every UI
//      test while confidently reporting the opposite of what the scan does.
//   2. The trial measures against the results ON SCREEN (kept/folded), not
//      against the word list, so its answer stays true after a save.
//   3. Saving writes the file and does NOT re-scan; the draft survives collapse,
//      and a removal is a real removal.
//   4. Rejects name the word that killed them, from the gate's own `gateReason`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PANEL = "components/explore/gate-panel.tsx";
const LIST = "components/explore/results-list.tsx";
const GATE = "lib/browser-search.mjs";
const I18N = "lib/i18n/clusters/explore.ts";
const read = (rel) => readFileSync(join(here, "../../src", rel), "utf8");
const flat = (rel) => read(rel).replace(/\s+/g, " ");

/** The GatePanel body, up to the first module-level helper after it. */
function panelBody() {
  const src = read(PANEL);
  const start = src.indexOf("export function GatePanel(");
  assert.ok(start >= 0, "GatePanel is gone — nothing tells the user what the gate filtered by, or lets them change it");
  const end = src.indexOf("function addOne(");
  assert.ok(end > start, "could not bound the GatePanel body");
  return src.slice(start, end).replace(/\s+/g, " ");
}

test("the gate and the trial judge with one implementation, never a second rule", () => {
  const gate = flat(GATE);
  assert.match(gate, /import \{ buildTitleFilterExplained \} from "\.\/core\/title-keywords\.mjs"/, "the gate must get its verdict from the explained builder");
  assert.match(gate, /const gate = buildTitleFilterExplained\(titleFilter\)/, "…and use it as the verdict, not only for the reasons");
  assert.match(gate, /dropped\.push\(\{ \.\.\.job, gateReason: gate\.explain\(title\) \}\)/, "a reject must carry the reason the gate itself computed");

  const panel = flat(PANEL);
  assert.match(panel, /import \{ buildTitleFilterExplained \} from "@\/lib\/core\/title-keywords\.mjs"/, "the trial must import the SAME builder the gate uses");
  assert.match(panel, /const gate = buildTitleFilterExplained\(\{ positive: draft\.positive, negative: draft\.negative \}\)/, "the trial must compile the draft through it");
  const body = panelBody().replace(/\s+/g, " ");
  for (const forbidden of ["buildTitleFilter(", "compileKeyword", "compilePositiveKeyword"]) {
    assert.ok(
      !body.includes(forbidden),
      `the panel must not reach for a second matcher (found "${forbidden}") — a panel with its own idea of the rule still passes every UI test while reporting the opposite of what the scan will do`,
    );
  }
});

test("the trial measures against the results on screen, so its answer survives a save", () => {
  const body = panelBody();
  assert.match(body, /rescue: folded\.filter\(\(o\) => gate\.pass\(String\(o\.title \?\? ""\)\)\)/, "「会放行」 = the rejects this list would keep");
  assert.match(body, /drop: kept\.filter\(\(o\) => !gate\.pass\(String\(o\.title \?\? ""\)\)\)/, "「会多毙」 = the survivors this list would kill");
  assert.ok(
    !/draft\.positive\.length/.test(body.slice(body.indexOf("const trial"), body.indexOf("const dirty"))),
    "the baseline is the current result set, not the word list: comparing list-against-list would report 0/0 the moment the save lands, and the one thing the user wanted to know (which postings would come back) would vanish exactly then",
  );
  const list = flat(LIST);
  assert.match(list, /kept=\{offers\} folded=\{folded\}/, "the panel needs both halves of the gate's own output");
});

test("saving writes the file and does not re-scan", () => {
  const body = panelBody();
  assert.match(body, /fetch\("\/api\/portals\/title-filter", \{ method: "POST"/, "the save must go to the word-list route (a replace), not to the append-only role seeder");
  assert.match(body, /onSaved\(draft\.positive, draft\.negative\)/, "the provider's filters must follow the file, or the card describes a file that no longer exists");
  assert.match(body, /t\("explore\.results\.gateSaved"\)/, "a successful save has to say when it takes effect");
  for (const forbidden of ["discoverBrowser", "discover(", "loadFresh"]) {
    assert.ok(
      !body.includes(forbidden),
      `the panel must not re-scan on save (found "${forbidden}") — the word list takes effect on the NEXT scan; re-running one would read as if deleting a word retracted a posting the user already saw`,
    );
  }
  assert.match(body, /method: "POST"/, "and there must be exactly one write path");
});

test("an unsaved edit is never thrown away by closing the modal or by an unrelated filter change", () => {
  const body = panelBody();
  assert.match(body, /const \[draft, setDraft\] = useState<Words>\(\(\) => \(\{ positive: \[\.\.\.positive\], negative: \[\.\.\.negative\] \}\)\)/, "the draft must live in component state, not be derived from props");
  assert.match(body, /const dirty = isDirty\(draft, \{ positive, negative \}\)/, "dirtiness is content, not identity");
  assert.match(body, /if \(next === seeded\.current\) return;/, "the reseed must compare CONTENT — `filters` is a fresh object on every setFilters, so an identity check would wipe in-progress edits whenever the user touched an unrelated condition");
  // The card is gone; the dirty badge lives on the toolbar 「配置」 button (the modal's only
  // entry), reported up via onDirtyChange — closed is exactly when the user needs to know
  // the edits are still parked.
  assert.match(body, /onDirtyChange\?\.\(dirty\)/, "the panel must report dirtiness up, so the badge can sit on the entry button while the modal is closed");
  const list = flat(LIST);
  assert.match(list, /t\("explore\.results\.gateUnsaved"\)/, "the 「未保存」 badge must render on the toolbar button — outside the modal, visible while it is closed");
  assert.ok(!panelBody().includes("gateUnsaved"), "the badge must not be inside the modal body, where it would only be readable after reopening");
});

test("a removal is a real removal, and adding a duplicate is a no-op", () => {
  const src = read(PANEL);
  assert.match(src, /const i = list\.indexOf\(w\)/, "removing must target the entry itself");
  assert.match(src, /\[\.\.\.list\.slice\(0, i\), \.\.\.list\.slice\(i \+ 1\)\]/, "…and remove exactly one occurrence — portals.yml really does repeat a word, and a filter-all would silently drop the other copy too");
  assert.match(src, /list\.some\(\(k\) => k\.trim\(\)\.toLowerCase\(\) === w\.trim\(\)\.toLowerCase\(\)\) \? list : \[\.\.\.list, w\]/, "adding must fold case and edge space, or the same word lands twice and the file grows a duplicate");
});

test("「拉黑所选」feeds candidate deny words into the panel's DRAFT, never a second write path", () => {
  const panel = flat(PANEL);
  assert.match(panel, /preaddNegative\?: string\[\] \| null/, "the panel accepts the blacklist-selected candidates");
  assert.match(panel, /mergeDenyWords\(d\.negative, preaddNegative\)/, "the preadd must land in the draft's negative side — saving stays the panel's one write path (the route test above pins that)");
  assert.match(panel, /if \(!preaddNegative \|\| preaddNegative\.length === 0\) return;/, "null/empty must be a no-op: mounting the page with no blacklist request must not touch the draft");
  // 新词必须在黑名单里可辨认：只亮真正落进草稿的词（已在表里的不闪，重复点拉黑也不
  // 重闪），且高亮与带入提示同一条生命周期——保存/放弃/手动编辑即清，不跨动作残留。
  assert.match(panel, /setPreaddedWords/, "the panel must remember which words the preadd just landed, so their chips can be highlighted");
  assert.match(panel, /!before\.some\(\(k\) => k\.trim\(\)\.toLowerCase\(\) === w\.toLowerCase\(\)\)/, "only words NOT already in the draft count as new — re-blacklisting the same selection must not re-light existing chips");
  assert.match(panel, /highlight=\{new Set\(preaddedWords\)\}/, "the highlight must reach the negative group's chips, not just the banner");
  const list = flat(LIST);
  assert.match(list, /suggestDenyWords\(selectedOffers\)/, "results-list derives the candidates from the selected rows' titles");
  assert.match(list, /preaddNegative=\{preadd\}/, "…and passes them down to the panel");
  assert.match(list, /selected\.size > 0 && isBsk &&/, "the entry only shows when rows are selected AND the gate is mounted (browser path) — a dead button on the ATS path would be worse than none");
  assert.match(list, /t\("explore\.results\.blacklistSelected"/, "the button is labeled");
  // The panel body must stay free of a second matcher — mergeDenyWords is a list
  // merge, not a matcher, so its presence is fine; the forbidden list below
  // re-checks the same three names the first test guards.
  const body = panelBody();
  for (const forbidden of ["buildTitleFilter(", "compileKeyword", "compilePositiveKeyword"]) {
    assert.ok(!body.includes(forbidden), `the preadd must not introduce a second matcher (found "${forbidden}")`);
  }
});

test("every reject names the word that killed it, read from the gate's own reason", () => {
  const list = read(LIST);
  assert.match(list, /o\.gateReason\.type === "negative"/, "a negative hit must be named");
  assert.match(list, /explore\.results\.filteredReasonNegative", \{ words: o\.gateReason\.words\.join\("／"\) \}/, "…as the user's own entries, all of them (an entry is a veto, not a ranking)");
  assert.match(list, /: t\("explore\.results\.filteredReasonNoPositive"\)/, "and 「nothing in the allow list matched」 must be distinguishable from 「this word killed it」 — the two call for opposite edits");
  assert.ok(
    !/compileKeyword|buildTitleFilter/.test(list),
    "the fold must render the reason the gate attached, not re-derive it: after an edit the panel's list and the results on screen are deliberately different, and a re-derived reason would describe the wrong one",
  );
});

test("the panel is labelled in both locales", () => {
  const src = read(I18N);
  const keys = [
    "explore.results.gateSummary",
    "explore.results.gateUnset",
    "explore.results.gatePositiveGroup",
    "explore.results.gateNegativeGroup",
    "explore.results.gateNone",
    "explore.results.gateQueryNote",
    "explore.results.gateUnsaved",
    "explore.results.gateAddPlaceholder",
    "explore.results.gateAdd",
    "explore.results.gateRemove",
    "explore.results.gateTrial",
    "explore.results.gateTrialRescue",
    "explore.results.gateTrialDrop",
    "explore.results.gateTrialNote",
    "explore.results.gateSave",
    "explore.results.gateSaving",
    "explore.results.gateDiscard",
    "explore.results.gateSaved",
    "explore.results.gateSaveFailed",
    "explore.results.blacklistSelected",
    "explore.results.blacklistTitle",
    "explore.results.gatePreadded",
    "explore.results.filteredReasonNegative",
    "explore.results.filteredReasonNoPositive",
    "explore.results.filteredMore",
  ];
  for (const key of keys) {
    const hits = (src.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) ?? []).length;
    assert.equal(hits, 2, `${key} must exist in both locales (found ${hits}) — an English-only key renders as the raw id in zh, which is how a missing translation ships unnoticed`);
  }
});
