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
//   3. Saving writes the file and does NOT re-scan; closing the modal discards the
//      draft, and a removal is a real removal.
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

test("closing the modal is a discard — every exit restores the saved list", () => {
  const body = panelBody();
  assert.match(body, /const \[draft, setDraft\] = useState<Words>\(\(\) => \(\{ positive: \[\.\.\.positive\], negative: \[\.\.\.negative\] \}\)\)/, "the draft must live in component state, not be derived from props");
  assert.match(body, /const dirty = isDirty\(draft, \{ positive, negative \}\)/, "dirtiness is content, not identity");
  const resetBody = body.slice(body.indexOf("const resetDraft ="), body.indexOf("const close ="));
  assert.ok(resetBody.length > 0, "could not bound the reset handler");
  assert.match(resetBody, /setDraft\(\{ positive: \[\.\.\.positive\], negative: \[\.\.\.negative\] \}\)/, "closing must restore the saved list — an edit that was never saved is an edit that never happened");
  // 三个出口（X / 遮罩 / Esc）必须收敛到同一个 close：漏掉任何一个，从它溜走的
  // 编辑会活到下一次打开，而「未保存」的信号已经不在了。
  assert.match(body, /if \(e\.target === e\.currentTarget\) close\(\)/, "the backdrop click must discard, not just hide");
  assert.match(body, /onClick=\{close\} aria-label=\{t\("explore\.results\.gateClose"\)\}/, "the X button must discard too");
  assert.match(body, /if \(e\.key === "Escape"\) close\(\)/, "Esc is the same low-commitment exit, so it discards as well");
  // 关掉即放弃后，没有「未保存」可提醒：徽标与上报通道一并撤掉。
  assert.ok(!body.includes("onDirtyChange"), "the panel must not report dirtiness up any more — nothing survives a close to come back for");
  const list = flat(LIST);
  assert.ok(!list.includes("gateUnsaved"), "the 「未保存」 badge has no meaning once closing discards the draft");
});

test("an unrelated filter change never wipes an in-progress edit", () => {
  const body = panelBody();
  assert.match(body, /if \(next === seeded\.current\) return;/, "the reseed must compare CONTENT — `filters` is a fresh object on every setFilters, so an identity check would wipe in-progress edits whenever the user touched an unrelated condition");
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
  assert.match(list, /\{isBsk && \(/, "the entry is mounted on the browser path only (a dead button on the ATS path would be worse than none)");
  assert.match(list, /disabled=\{noVisibleSelection\}/, "…and it stays VISIBLE while nothing is selected, disabled instead of unmounted — a toolbar that grows/shrinks buttons as you tick rows moves the primary CTA under the cursor");
  assert.match(list, /t\("explore\.results\.blacklistSelected", \{ n: selectedOffers\.length \}\)/, "the count must be the visible selection, not the whole one: after a salary/keyword filter, selected.size still holds rows off screen");
  // The panel body must stay free of a second matcher — mergeDenyWords is a list
  // merge, not a matcher, so its presence is fine; the forbidden list below
  // re-checks the same three names the first test guards.
  const body = panelBody();
  for (const forbidden of ["buildTitleFilter(", "compileKeyword", "compilePositiveKeyword"]) {
    assert.ok(!body.includes(forbidden), `the preadd must not introduce a second matcher (found "${forbidden}")`);
  }
});

// 行内单行「拉黑」：与工具栏同一回路（同一个弹窗、同一份草稿、同一个保存口），只是候选
// 词只取这一行的标题。没有这条守卫，下次重构很容易给单行另开一条写路径，或者让它顺手
// 把行隐掉——那就是第二种语义了，而用户点的是「拉黑」，不是「移除」。
test("行内「拉黑」与批量同一条回路 — 候选词只取这一行的标题", () => {
  const list = flat(LIST);
  assert.match(
    list,
    /setPreadd\(suggestDenyWords\(\[offer\]\)\)/,
    "the single-row entry must derive candidates from THAT row's title (an array of one), through the same deny-words module as the bulk button",
  );
  assert.match(
    list,
    /onBlacklist=\{isBsk \? \(\) => blacklistOne\(o\) : undefined\}/,
    "the row's button must reach the same handler, and only on the browser path where the gate exists",
  );
  // 与批量同一个出口：候选词只是并进草稿，保存仍只在弹窗里发生。
  const one = list.slice(list.indexOf("const blacklistOne ="), list.indexOf("const noVisibleSelection"));
  assert.ok(one.length > 0, "could not bound the single-row handler");
  assert.match(one, /setGateOpen\(true\)/, "the row button opens the same modal rather than writing anything itself");
  assert.ok(!/api\/portals|fetch\(/.test(one), "no second write path — the row button must not save on the user's behalf");

  const card = flat("components/explore/discovery-card.tsx");
  assert.match(card, /onBlacklist\?: \(\) => void;/, "the row takes the handler as an optional prop");
  assert.match(card, /\{onBlacklist && \(/, "no handler = no button: a dead 拉黑 on the ATS path is worse than none");
  assert.match(card, /t\("explore\.results\.blacklistRowTitle"\)/, "the button has to say what it does to a title word, not just 「拉黑」");
});

// 「删一个带入词，其余就不亮了」。仓里没有组件渲染基建（ADR-0072 known gap），所以这条
// 只能锁形状；真正按 DOM 跑的红/绿复现在 web/tests/debug/explore-blacklist-highlight-
// removal.mjs（Playwright + 固定快照），修之前观测到 4 个高亮 → 删一个 → 0 个。
test("deleting one brought-in word re-lights only itself, never the whole batch", () => {
  const body = panelBody();
  // 只看 edit 本身：「放弃改动」那个按钮本来就该整批清空（词表回到已存表，带入词一个
  // 都不该还亮），把它算进来会让这条断言永远不可能绿。
  const editBody = body.slice(body.indexOf("const edit ="), body.indexOf("const save ="));
  assert.ok(editBody.length > 0, "could not bound the edit handler");
  // 任何手动编辑都把高亮集整批清空，正是用户报的这一条：其余带入词、连同顶部「带入 N 个」
  // 的提示一起消失，读起来像「拉黑只带进来一条」。
  assert.ok(
    !/setPreaddedWords\(\[\]\)/.test(editBody),
    "a manual edit must not blanket-clear the preadd highlight set — drop only the word being removed",
  );
  assert.match(
    editBody,
    /if \(remove && side === "negative"\)/,
    "the highlight only ever shrinks on a NEGATIVE removal: the positive group shares the same draft and never carried a preadd highlight",
  );
  assert.match(
    editBody,
    /setPreaddedWords\(\(prev\) => prev\.filter\(\(k\) => k !== key\)\)/,
    "…and by dropping that one normalized key, so the other brought-in words stay lit",
  );
  assert.match(
    editBody,
    /list\.some\(\(k\) => k\.trim\(\)\.toLowerCase\(\) === key\)/,
    "only unhighlight once the word is REALLY gone: portals.yml repeats a word, and deleting one copy must not darken the other",
  );
});

// 词条改名：点 chip 就地变输入框。重名不静默吞掉——与「加词去重」同一口径（addOne
// 静默 no-op），但用户点的是一条已有的词，静默等于告诉他「改好了」，而文件里还是旧词。
// 所以这里必须看得见地拒绝：提示在组下方，重名时留在编辑态等用户改。
test("a chip is editable in place, and a duplicate name is refused out loud", () => {
  const src = read(PANEL);
  const body = panelBody();
  // 按序号改名：portals.yml 的 negative 里真有重复词，按值改会改错那一条。
  assert.match(src, /onRename: \(index: number, w: string\) => void/, "the group must rename by index, not by value — a repeated word would otherwise rename the wrong copy");
  assert.match(src, /function renameOne\(list: string\[\], i: number, w: string\)/, "renaming is a position-aware splice, sitting next to addOne/removeOne");
  assert.match(body, /const rename = \(side: keyof Words, index: number, w: string\)/, "the panel owns the rename write into the draft");
  assert.match(body, /onRename=\{\(i, w\) => rename\("positive", i, w\)\}/, "the allow group must be editable too, not just the deny group");
  assert.match(body, /onRename=\{\(i, w\) => rename\("negative", i, w\)\}/, "the deny group wires its rename to the same draft");
  // 编辑入口：chip 文字本身是按钮（× 仍是删除，两个动作分开）。
  assert.match(src, /onClick=\{\(\) => begin\(i\)\}/, "clicking the word must start editing it, not remove it");
  // 重名提示是派生的、跟着输入实时变——不是提交时才第一次说话；且只在真改动了才说话
  // （portals.yml 的 negative 里本来就有两条「销售」，点开其中一条不能一上来就报重名）。
  assert.match(
    src,
    /const dup = editing !== null && value\.trim\(\) !== words\[editing\] && sameWord\(words, editing, value\)/,
    "the duplicate hint must be derived from what is being typed, live — and stay quiet until the text actually changes",
  );
  assert.match(src, /if \(sameWord\(words, i, w\)\) return;/, "a duplicate commit must be refused, leaving the edit open");
  assert.match(src, /function sameWord\(list: string\[\], i: number, w: string\)/, "the duplicate test skips the entry being edited and folds case/space like addOne");
  assert.match(src, /k\.trim\(\)\.toLowerCase\(\) === key/, "…case- and edge-space-insensitive, or 「IT」/「it」 slips in as two entries");
  assert.match(src, /t\("explore\.results\.gateEditDuplicate", \{ w: value\.trim\(\) \}\)/, "the refusal has to say which word collided");
  // Esc 只撤这次改名：弹窗级 Esc 监听会把整个面板关掉，草稿一起丢。
  assert.match(src, /e\.stopPropagation\(\);/, "Escape inside the rename input must not bubble up to the modal's close handler");
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
    "explore.results.gateAddPlaceholder",
    "explore.results.gateAdd",
    "explore.results.gateRemove",
    "explore.results.gateEdit",
    "explore.results.gateEditHint",
    "explore.results.gateEditDuplicate",
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
    "explore.results.blacklistRow",
    "explore.results.blacklistRowTitle",
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
