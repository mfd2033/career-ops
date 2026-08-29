// opencode-models: the config page's opencode model dropdown must reflect the
// user's REAL opencode config (providers + models), not a static list.
//
// This module reads opencode.jsonc (user-level + project-level), strips JSONC
// comments, skips disabled_providers, and collects every provider model.
//
// Run:  node --test tests/lib/opencode-models.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as mod from "../../src/lib/opencode-models.mjs";

/** Write fixture config files into a temp dir and return the paths to read. */
function withTempConfig(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-models-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const fp = join(dir, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Object.keys(files).map((rel) => join(dir, rel));
}

test("loads provider models from the user-level opencode.jsonc", (t) => {
  const paths = withTempConfig(t, {
    "config/opencode.jsonc": `{
      "provider": {
        "b-ai": {
          "npm": "@ai-sdk/openai-compatible",
          "options": { "baseURL": "https://api.b.ai/v1" },
          "models": {
            "deepseek-v4-flash": { "name": "deepseek-v4-flash" },
            "glm-5.3-flash": { "name": "glm-5.3-flash" }
          }
        },
        "model-scope": {
          "models": {
            "deepseek-ai/DeepSeek-V4-Pro": { "name": "DeepSeek-V4-Pro" }
          }
        }
      }
    }`,
  });
  const models = mod.loadOpencodeModelsFromFiles(paths);
  assert.deepEqual(models, [
    { id: "b-ai/deepseek-v4-flash", label: "b-ai/deepseek-v4-flash" },
    { id: "b-ai/glm-5.3-flash", label: "b-ai/glm-5.3-flash" },
    { id: "model-scope/deepseek-ai/DeepSeek-V4-Pro", label: "model-scope/deepseek-ai/DeepSeek-V4-Pro" },
  ]);
});

test("skips providers listed in disabled_providers", (t) => {
  const paths = withTempConfig(t, {
    "config/opencode.jsonc": `{
      "disabled_providers": ["bigmodel"],
      "provider": {
        "bigmodel": { "models": { "glm-4.7-flash": {} } },
        "b-ai": { "models": { "deepseek-v4-flash": {} } }
      }
    }`,
  });
  const models = mod.loadOpencodeModelsFromFiles(paths);
  assert.deepEqual(models, [{ id: "b-ai/deepseek-v4-flash", label: "b-ai/deepseek-v4-flash" }]);
});

test("strips JSONC comments before parsing", (t) => {
  const paths = withTempConfig(t, {
    "config/opencode.jsonc": `{
      // a comment
      "provider": {
        "b-ai": { "models": { "deepseek-v4-flash": { "name": "deepseek-v4-flash" } } } // trailing
      }
    }`,
  });
  const models = mod.loadOpencodeModelsFromFiles(paths);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "b-ai/deepseek-v4-flash");
});

test("project-level opencode.jsonc merges in when present", (t) => {
  const paths = withTempConfig(t, {
    "user/opencode.jsonc": `{ "provider": { "b-ai": { "models": { "a": {} } } } }`,
    "project/opencode.jsonc": `{ "provider": { "volces": { "models": { "glm-5-2-260617": {} } } } }`,
  });
  const models = mod.loadOpencodeModelsFromFiles(paths);
  assert.deepEqual(models.map((m) => m.id).sort(), ["b-ai/a", "volces/glm-5-2-260617"]);
});

test("returns empty when no config exists", (t) => {
  const paths = withTempConfig(t, {});
  assert.deepEqual(mod.loadOpencodeModelsFromFiles(paths), []);
});

test("dedupes a model seen in both user and project config", (t) => {
  const paths = withTempConfig(t, {
    "user/opencode.jsonc": `{ "provider": { "b-ai": { "models": { "deepseek-v4-flash": {} } } } }`,
    "project/opencode.jsonc": `{ "provider": { "b-ai": { "models": { "deepseek-v4-flash": {} } } } }`,
  });
  const models = mod.loadOpencodeModelsFromFiles(paths);
  assert.equal(models.length, 1);
});

test("broken JSON is skipped, not fatal", (t) => {
  const paths = withTempConfig(t, {
    "config/opencode.jsonc": `{ this is not json`,
    "project/opencode.jsonc": `{ "provider": { "b-ai": { "models": { "ok": {} } } } }`,
  });
  const models = mod.loadOpencodeModelsFromFiles(paths);
  assert.deepEqual(models, [{ id: "b-ai/ok", label: "b-ai/ok" }]);
});

test("parseModelsOutput turns command output into id/label pairs", () => {
  const out = [
    "opencode/hy3-free",
    "opencode/mimo-v2.5-free",
    "model-scope/deepseek-ai/DeepSeek-V4-Pro",
    "",
  ].join("\r\n");
  assert.deepEqual(mod.parseModelsOutput(out), [
    { id: "opencode/hy3-free", label: "opencode/hy3-free" },
    { id: "opencode/mimo-v2.5-free", label: "opencode/mimo-v2.5-free" },
    { id: "model-scope/deepseek-ai/DeepSeek-V4-Pro", label: "model-scope/deepseek-ai/DeepSeek-V4-Pro" },
  ]);
});

test("loadOpencodeModels falls back to config files when the command cannot run", (t) => {
  // A nonexistent bin path makes execFileSync throw → the file-based fallback
  // must still yield models instead of crashing.
  const dir = mkdtempSync(join(tmpdir(), "opencode-models-fallback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "opencode.jsonc"), `{ "provider": { "b-ai": { "models": { "deepseek-v4-flash": {} } } } }`);
  const realCwd = process.cwd;
  process.cwd = () => dir;
  t.after(() => {
    process.cwd = realCwd;
  });
  const models = mod.loadOpencodeModels("definitely-not-a-real-binary-xyz");
  // The fallback reads the real config paths first (user-level may exist on the
  // developer machine), so the exact model set is machine-dependent — assert the
  // contract that matters: it returns a non-empty list instead of throwing.
  assert.ok(models.length >= 1, "fallback should yield at least one model");
  assert.ok(models.every((m) => m.id && m.label), "every fallback model carries id + label");
});

