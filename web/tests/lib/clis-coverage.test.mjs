// Every CLI with a documented headless invocation must be selectable in the web UI.
//
// This guards the drift that let Grok Build CLI go missing: it was wired into
// doctor.mjs (VALID_CLIS), the scaffolder, docs/SUPPORTED_CLIS.md, the README
// and .grok/skills/, yet KNOWN in web/src/lib/clis.ts never listed it — so the
// web UI silently could not run on it. Nothing tied the two lists together.
//
// clis.ts is TypeScript and these tests are .mjs, so KNOWN is read as text. That
// is deliberate: a regex over `bin: "..."` is enough to catch a forgotten entry,
// and it keeps the guard free of a build step.
//
// Run:  node --test tests/lib/clis-coverage.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIS_TS = join(WEB, "src", "lib", "clis.ts");
const SUPPORTED_MD = join(WEB, "..", "docs", "SUPPORTED_CLIS.md");

/** Binaries KNOWN can spawn. */
function knownBins(src) {
  return new Set([...src.matchAll(/bin:\s*"([^"]+)"/g)].map((m) => m[1]));
}

/** Binaries docs/SUPPORTED_CLIS.md promises work headlessly. A CLI documented
 *  as interactive-only (Cursor, Kimi) is correctly absent from KNOWN — the web
 *  UI drives workers headlessly and has nothing to offer them. */
function documentedHeadlessBins(md) {
  return new Set([...md.matchAll(/Headless\/Batch:\s*`([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
}

const src = readFileSync(CLIS_TS, "utf8");
const md = readFileSync(SUPPORTED_MD, "utf8");

/** A regex-escaped id. An id may contain `-` (`qoder-cn`), which is not legal
 *  in a TS identifier — so its MODELS key is quoted and its accessor is
 *  bracketed. The guards below must tolerate both spellings or a hyphenated
 *  engine slips past them (it did: `qoder-cn`, ADR-0052). */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The MODELS object key for an engine, bare (`claude:`) or quoted
 *  (`"qoder-cn":`), followed by the given property. */
function modelEntryRe(id, tail) {
  return new RegExp(`"?${escapeRe(id)}"?:\\s*\\{[\\s\\S]*?${tail}`);
}

/** How a KNOWN row reaches its MODELS entry: `MODELS.claude`, or
 *  `MODELS["qoder-cn"]` when the id is not an identifier. */
function modelAccessRe(id) {
  return `MODELS(?:\\.${escapeRe(id)}|\\["${escapeRe(id)}"\\])`;
}

/** The engine ids KNOWN declares, in file order. An `id:` immediately followed
 *  by `name:` is a KNOWN row; MODELS options carry `id:` + `label:` instead. */
function knownIds(src) {
  return [...src.matchAll(/id:\s*"([^"]+)",\s*name:/g)].map((m) => m[1]);
}

test("the fixtures this guard reads still look like themselves", () => {
  // If either file is refactored past these regexes, the checks below would
  // pass vacuously over empty sets. Fail loudly instead.
  assert.ok(knownBins(src).size >= 7, "KNOWN parsed as near-empty — has clis.ts changed shape?");
  assert.ok(documentedHeadlessBins(md).size >= 5, "no headless rows parsed — has the docs table changed shape?");
});

test("every documented headless CLI is selectable in the web UI", () => {
  const known = knownBins(src);
  const missing = [...documentedHeadlessBins(md)].filter((bin) => !known.has(bin));
  assert.deepEqual(missing, [], `documented headless but absent from KNOWN in clis.ts: ${missing.join(", ")}`);
});

test("Grok Build CLI is wired up", () => {
  // The regression that motivated this file. Named explicitly so a future
  // reshuffle of the docs table can't quietly drop coverage for it.
  assert.match(src, /id:\s*"grok"/, "KNOWN is missing the grok entry");
  assert.match(src, /bin:\s*"grok"/, "the grok entry must spawn the `grok` binary");
});

test("no CLI is listed twice", () => {
  // id followed by name: distinguishes KNOWN rows from the model options inside
  // MODELS, which also carry `id:` keys (opus, sonnet, auto, …).
  const ids = knownIds(src);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in KNOWN: ${ids.join(", ")}`);
});

test("every KNOWN CLI carries model metadata (flag + default + options list)", () => {
  // The config page's model picker is keyed by id → MODELS entry. A CLI that
  // reaches KNOWN without model metadata silently disappears from the picker,
  // and its runs never get a --model — the same drift that hid Grok.
  //
  // The option list itself may legitimately be EMPTY: an engine whose catalogue
  // is owned by the CLI gets it fetched at detection time (qoder-cn →
  // qoder-models.mjs, ADR-0052 决议 9), and an empty list makes the page render
  // no picker rather than an unselectable phantom. What this guard pins is that
  // the entry exists and is shaped like a ModelMeta — not that a human
  // transcribed the list.
  const ids = knownIds(src);
  for (const id of ids) {
    assert.match(src, new RegExp(`"?${escapeRe(id)}"?:\\s*\\{\\s*flag:`), `MODELS is missing a '${id}' entry (modelFlag)`);
    assert.match(src, modelEntryRe(id, "default:"), `MODELS['${id}'] is missing a default model`);
    assert.match(src, modelEntryRe(id, "options:\\s*\\["), `MODELS['${id}'] is missing an options list`);
  }
  // And each KNOWN row wires the model field to its MODELS entry.
  for (const id of ids) {
    assert.match(src, new RegExp(`id: "${escapeRe(id)}"[\\s\\S]*?model: ${modelAccessRe(id)}`), `KNOWN row for '${id}' must set model: MODELS.${id}`);
  }
});

test("the default model of every CLI is one of its own options", () => {
  // The "current model" readout falls back to MODELS[id].default when nothing
  // is saved. A default that is not in options renders as an unselectable
  // phantom in the dropdown — detect that here.
  // Quoted keys included (`"qoder-cn":`): an id that is not a TS identifier can
  // only be spelled that way, and skipping those keys would leave the newest
  // engines silently uncovered.
  const defaultRe = /"?([\w-]+)"?:\s*\{\s*flag:\s*"[^"]*",\s*default:\s*"([^"]*)"/g;
  let m;
  while ((m = defaultRe.exec(src))) {
    const [, id, def] = m;
    if (!def) continue; // antigravity and qoder-cn: deliberately empty (account/CLI-dependent)
    const optionsRe = modelEntryRe(id, "options:\\s*\\[([\\s\\S]*?)\\]");
    const optsMatch = optionsRe.exec(src);
    assert.ok(optsMatch, `no options parsed for ${id}`);
    const optionIds = [...optsMatch[1].matchAll(/id:\s*"([^"]+)"/g)].map((x) => x[1]);
    assert.ok(
      optionIds.includes(def),
      `${id}: default "${def}" is not among its options (${optionIds.join(", ")})`,
    );
  }
});
