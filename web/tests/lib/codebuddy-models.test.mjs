// CodeBuddy Code's model catalogue reader — the runtime half of the config
// page's CodeBuddy picker (the static half stays in clis.ts as ADR-0073 guard
// evidence + fallback).
//
// The --help excerpt below is the VERBATIM stdout of `codebuddy --help` on
// v2.161.4 (2026-11-16), the release that shipped hy4flash-free / hy4flash —
// not an invented sample. The "Currently supported: (…)" marker is the trap
// this file exists for: the rest of --help is usage noise, and a reader that
// split every line would offer "--permission-mode" as a selectable model.
//
// Run:  node --test tests/lib/codebuddy-models.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCodebuddyModels, parseCodebuddyModelsOutput, resetCodebuddyModelCache } from "../../src/lib/codebuddy-models.mjs";

const CLIS_TS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "lib", "clis.ts");
const clisSrc = readFileSync(CLIS_TS, "utf8");

const REAL_OUTPUT = `CodeBuddy Code CLI 2.161.4

  -p, --print                                       Print response without interactive UI
  --permission-mode <mode>                          Default permission mode for this process. Choices: acceptEdits, bypassPermissions, default, plan, dontAsk, auto.
  --model <model>                                   Model for the current session. Please provide the model ID. Currently supported: (hy4std, hy4flash-free, hy4flash, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, space-bunny, minimax-m3.1-flash, minimax-m2.7, kimi-k3.1-pro, kimi-k3-1, kimi-k2.8-preview, deepseek-v4-pro, step-5-preview, mimo-v2.6-pro, custom-local:agnes-3.0-flash, custom-local:u2-flash)
  --fallback-model <model>                          Enable automatic fallback to specified model when default model is overloaded (only works with --print)
  -v, --version                                     Output the version number (default: false)
`;

const EXPECTED_IDS = [
  "hy4std",
  "hy4flash-free",
  "hy4flash",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "space-bunny",
  "minimax-m3.1-flash",
  "minimax-m2.7",
  "kimi-k3.1-pro",
  "kimi-k3-1",
  "kimi-k2.8-preview",
  "deepseek-v4-pro",
  "step-5-preview",
  "mimo-v2.6-pro",
  "custom-local:agnes-3.0-flash",
  "custom-local:u2-flash",
];

test("parse: the real output yields its 18 ids, help noise dropped, order kept", () => {
  const models = parseCodebuddyModelsOutput(REAL_OUTPUT);
  assert.equal(models.length, 18);
  assert.deepEqual(
    models.map((m) => m.id),
    EXPECTED_IDS,
  );
  assert.ok(!models.some((m) => m.id.startsWith("-")), "a usage flag must never become an option");
  assert.ok(!models.some((m) => m.id.includes("model")), "the --model flag spelling must not leak into the list");
});

test("parse: id and label are the same string — --model takes the id verbatim", () => {
  for (const m of parseCodebuddyModelsOutput(REAL_OUTPUT)) assert.equal(m.label, m.id);
});

test("parse: CRLF, extra spaces and duplicates are tolerated", () => {
  const out = "--model <model> Currently supported: (hy4std,  hy4flash-free ,\r\n  hy4std, hy4flash)\r\n";
  assert.deepEqual(parseCodebuddyModelsOutput(out).map((m) => m.id), ["hy4std", "hy4flash-free", "hy4flash"]);
});

test("parse: no marker, blank input, or an empty list are all empty", () => {
  assert.deepEqual(parseCodebuddyModelsOutput("--model <model>  Model for the current session"), []);
  assert.deepEqual(parseCodebuddyModelsOutput(""), []);
  assert.deepEqual(parseCodebuddyModelsOutput("Currently supported: ()"), []);
  assert.deepEqual(parseCodebuddyModelsOutput(null), []);
  assert.deepEqual(parseCodebuddyModelsOutput(undefined), []);
});

// --- the command path -------------------------------------------------------

test("load: parses the CLI's answer and caches it across calls", async () => {
  resetCodebuddyModelCache();
  let calls = 0;
  const exec = () => {
    calls++;
    return REAL_OUTPUT;
  };
  assert.equal((await loadCodebuddyModels("codebuddy", exec)).length, 18);
  assert.equal((await loadCodebuddyModels("codebuddy", exec)).length, 18);
  assert.equal(calls, 1, "a second call inside the TTL must not spawn again");
  resetCodebuddyModelCache();
});

test("load: a manual re-check really re-queries", async () => {
  resetCodebuddyModelCache();
  let calls = 0;
  const exec = () => {
    calls++;
    return REAL_OUTPUT;
  };
  await loadCodebuddyModels("codebuddy", exec);
  resetCodebuddyModelCache();
  await loadCodebuddyModels("codebuddy", exec);
  assert.equal(calls, 2, "detectClisCached({refresh:true}) must force a real query");
  resetCodebuddyModelCache();
});

test("load: a broken CLI (the command throws) is an EMPTY list, and is not cached", async () => {
  resetCodebuddyModelCache();
  let calls = 0;
  const exec = () => {
    calls++;
    throw new Error("Command failed");
  };
  assert.deepEqual(await loadCodebuddyModels("codebuddy", exec), []);
  assert.deepEqual(await loadCodebuddyModels("codebuddy", exec), []);
  assert.equal(calls, 2, "a failure must not be cached — the CLI may recover between page loads");
  resetCodebuddyModelCache();
});

test("load: a help text without the marker is an empty list, not a phantom model", async () => {
  resetCodebuddyModelCache();
  assert.deepEqual(await loadCodebuddyModels("codebuddy", () => "CodeBuddy Code CLI 2.161.4\n"), []);
  resetCodebuddyModelCache();
});

// --- wiring -----------------------------------------------------------------
//
// Detection is the only caller, and it lives in clis.ts (TypeScript read as
// text, like the repo's other clis.ts guards). Without this, clis.ts could stop
// consulting this module — or stop invalidating its cache on a manual re-check —
// while every unit above still passes.

test("clis.ts reads the catalogue for codebuddy and invalidates it on a manual re-check", () => {
  assert.match(clisSrc, /c\.id === "codebuddy"[\s\S]{0,400}?loadCodebuddyModels\(/, "detection must ask this module for the codebuddy catalogue");
  assert.match(clisSrc, /resetCodebuddyModelCache\(\)/, "a manual re-check must drop the cached catalogue");
});
