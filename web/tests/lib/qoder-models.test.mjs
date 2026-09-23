// Qoder CN's model catalogue reader (ADR-0052 决议 7-9).
//
// The 14 names below are the VERBATIM stdout of `qoderclicn --list-models` on
// v1.1.41 (header row included) — not an invented sample. The header is the
// trap this file exists for: opencode's equivalent prints one bare id per line,
// so a reader borrowed from there would offer "MODEL" as a selectable model.
//
// Run:  node --test tests/lib/qoder-models.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadQoderModels, parseQoderModelsOutput, resetQoderModelCache } from "../../src/lib/qoder-models.mjs";

const CLIS_TS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "lib", "clis.ts");
const clisSrc = readFileSync(CLIS_TS, "utf8");

const REAL_OUTPUT = `MODEL
Auto
Qwen3.8-Max
Qwen3.8-Flash
Qwen3.7-Max
Qwen3.7-Plus
Qwen3.7-Flash
DeepSeek-V4-Pro
DeepSeek-Flash
GLM-5.3
GLM-5.3-Flash
GLM-5.2
Kimi-K3
Kimi-K2.8-Preview
MiniMax-M2.7
`;

test("parse: the real output yields its 14 names, header dropped, order kept", () => {
  const models = parseQoderModelsOutput(REAL_OUTPUT);
  assert.equal(models.length, 14);
  assert.deepEqual(
    models.map((m) => m.id),
    [
      "Auto",
      "Qwen3.8-Max",
      "Qwen3.8-Flash",
      "Qwen3.7-Max",
      "Qwen3.7-Plus",
      "Qwen3.7-Flash",
      "DeepSeek-V4-Pro",
      "DeepSeek-Flash",
      "GLM-5.3",
      "GLM-5.3-Flash",
      "GLM-5.2",
      "Kimi-K3",
      "Kimi-K2.8-Preview",
      "MiniMax-M2.7",
    ],
  );
  assert.ok(!models.some((m) => m.id === "MODEL"), "the header must never become an option");
});

test("parse: id and label are the same string — --model takes the display name", () => {
  for (const m of parseQoderModelsOutput(REAL_OUTPUT)) assert.equal(m.label, m.id);
});

test("parse: no header, blank lines, CRLF and duplicates are all tolerated", () => {
  assert.deepEqual(parseQoderModelsOutput("Qwen3.8-Flash\r\n\r\n  Kimi-K3  \r\nQwen3.8-Flash\r\n").map((m) => m.id), ["Qwen3.8-Flash", "Kimi-K3"]);
});

test("parse: nothing in, nothing out", () => {
  assert.deepEqual(parseQoderModelsOutput(""), []);
  assert.deepEqual(parseQoderModelsOutput("   \n  \n"), []);
  assert.deepEqual(parseQoderModelsOutput(null), []);
  assert.deepEqual(parseQoderModelsOutput(undefined), []);
  assert.deepEqual(parseQoderModelsOutput("MODEL\n"), []);
});

// --- the command path -------------------------------------------------------

test("load: parses the CLI's answer and caches it across calls", () => {
  resetQoderModelCache();
  let calls = 0;
  const exec = () => {
    calls++;
    return REAL_OUTPUT;
  };
  assert.equal(loadQoderModels("qoderclicn", exec).length, 14);
  assert.equal(loadQoderModels("qoderclicn", exec).length, 14);
  assert.equal(calls, 1, "a second call inside the TTL must not spawn again");
  resetQoderModelCache();
});

test("load: a manual re-check really re-queries", () => {
  resetQoderModelCache();
  let calls = 0;
  const exec = () => {
    calls++;
    return REAL_OUTPUT;
  };
  loadQoderModels("qoderclicn", exec);
  resetQoderModelCache();
  loadQoderModels("qoderclicn", exec);
  assert.equal(calls, 2, "detectClisCached({refresh:true}) must force a real query");
  resetQoderModelCache();
});

test("load: not signed in (the command throws) is an EMPTY list, and is not cached", () => {
  resetQoderModelCache();
  let calls = 0;
  const exec = () => {
    calls++;
    const err = new Error("Command failed");
    err.stderr = "Not logged in. Run `qoderclicn login` to authenticate.";
    throw err;
  };
  assert.deepEqual(loadQoderModels("qoderclicn", exec), []);
  assert.deepEqual(loadQoderModels("qoderclicn", exec), []);
  assert.equal(calls, 2, "a failure must not be cached — the reason can change between page loads");
  resetQoderModelCache();
});

test("load: a headerless-but-empty answer is an empty list, not a phantom model", () => {
  resetQoderModelCache();
  assert.deepEqual(loadQoderModels("qoderclicn", () => "MODEL\n"), []);
  resetQoderModelCache();
});

// --- wiring -----------------------------------------------------------------
//
// Detection is the only caller, and it lives in clis.ts (TypeScript read as
// text, like the repo's other clis.ts guards). Without this, clis.ts could stop
// consulting this module — or stop invalidating its cache on a manual re-check —
// while every unit above still passes.

test("clis.ts reads the catalogue for qoder-cn and invalidates it on a manual re-check", () => {
  assert.match(clisSrc, /c\.id === "qoder-cn"[\s\S]{0,400}?loadQoderModels\(/, "detection must ask this module for the qoder-cn catalogue");
  assert.match(clisSrc, /resetQoderModelCache\(\)/, "a manual re-check must drop the cached catalogue");
});
