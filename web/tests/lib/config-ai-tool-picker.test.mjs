// Guards the config page's "AI tool" picker after it moved from a card list to a
// dropdown (mirroring the model picker).
//
// The change is a display change, so the invariants it can silently break are
// about what stays selectable, not about layout:
//   1. A CLI that is NOT installed must never become selectable — it is
//     知情信息 only, so it lives in a `disabled` <optgroup>. Building the
//      options from the full `clis` array would make a missing tool pickable
//      and the run would fail at spawn time.
//   2. Every dropdown on the page goes through one native-<select> component.
//      A second hand-rolled popup would drag in the keyboard/screen-reader
//      obligations the native control provides for free.
//   3. The new copy exists in BOTH dictionaries. A key added to `en` only
//      renders as its raw dotted name in the Chinese UI.
//
// clis.ts and config-form.tsx are read as text; these tests are .mjs and the
// sources are TS/TSX. Same deliberate tradeoff as clis-coverage.test.mjs: a
// regex over the invariants is enough, and it keeps the guard build-free.
//
// Run:  node --test tests/lib/config-ai-tool-picker.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORM = readFileSync(join(WEB, "src", "components", "config-form.tsx"), "utf8");
const DICT = readFileSync(join(WEB, "src", "lib", "i18n", "clusters", "config.ts"), "utf8");

/** Keys introduced by this change. */
const NEW_KEYS = [
  "config.aiTool",
  "config.aiToolDesc",
  "config.aiToolGroupInstalled",
  "config.aiToolGroupMissing",
  "config.aiToolMissingCount",
  "config.aiToolShowInstall",
  "config.aiToolHideInstall",
  "config.currentTool",
  "config.lastChecked",
  "config.recheck",
  "config.rechecking",
];

// Both dictionaries live in one file: everything after `export const zh` is the
// Chinese block.
const [enBlock, zhBlock] = DICT.split("export const zh");

test("the fixtures this guard reads still look like themselves", () => {
  // If either file is refactored past these markers the checks below would pass
  // vacuously. Fail loudly instead.
  assert.ok(enBlock.includes('"config.aiTool"'), "config.ts shape changed — key parsing is stale");
  assert.ok(zhBlock && zhBlock.includes('"config.aiTool"'), "no Chinese block parsed — config.ts shape changed");
  assert.ok(FORM.includes("<SelectField"), "config-form.tsx shape changed — no SelectField found");
});

test("a CLI that is not installed is never selectable", () => {
  assert.match(
    FORM,
    /<optgroup label=\{t\("config\.aiToolGroupMissing"\)\} disabled>/,
    "the not-installed group must be a disabled <optgroup>",
  );
  assert.match(FORM, /\{installed\.map\(\(c\) => \(/, "the selectable options must come from `installed`");
  // The pre-change card list rendered every CLI in `clis`; feeding that whole
  // array into <option> is exactly the regression this guards.
  assert.doesNotMatch(FORM, /\{clis\.map\(/, "AI tool options must be split into installed / missing");
});

test("every dropdown on the config page is the same native select", () => {
  const uses = [...FORM.matchAll(/<SelectField/g)].length;
  assert.equal(uses, 3, `expected 3 SelectField call sites (AI tool / model / unknown employer), found ${uses}`);
  // One `relative` wrapper is the component's own; a second means a dropdown
  // was hand-rolled instead of going through SelectField.
  const wrappers = [...FORM.matchAll(/<div className="relative">/g)].length;
  assert.equal(wrappers, 1, `expected the single SelectField wrapper, found ${wrappers}`);
});

test("the new copy exists in both dictionaries", () => {
  for (const key of NEW_KEYS) {
    assert.ok(enBlock.includes(`"${key}":`), `English dict is missing ${key}`);
    assert.ok(zhBlock.includes(`"${key}":`), `Chinese dict is missing ${key}`);
  }
});

test("engine mode and the tool picker no longer share one wording", () => {
  // "Use an AI tool you have" sat on the mode card while the picker below it was
  // also an "AI tool" — two layers, one word.
  assert.match(enBlock, /"config\.modeCli": "Use a CLI on this machine"/);
  assert.doesNotMatch(enBlock, /"config\.modeCli": "Use an AI tool you have"/);
  assert.match(zhBlock, /"config\.aiEngine": "引擎模式"/);
});
