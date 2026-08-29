import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveModelPicker } from "../../src/lib/model-picker.mjs";

test("no saved model → empty pick, unchanged options", () => {
  const opts = [{ id: "a", label: "A" }];
  const r = resolveModelPicker({ model: "", modelCliId: "", cliId: "opencode", options: opts });
  assert.equal(r.model, "");
  assert.deepEqual(r.options, opts);
});

test("saved model in options → preserved, options unchanged", () => {
  const opts = [
    { id: "x", label: "X" },
    { id: "y", label: "Y" },
  ];
  const r = resolveModelPicker({ model: "x", modelCliId: "opencode", cliId: "opencode", options: opts });
  assert.equal(r.model, "x");
  assert.deepEqual(r.options, opts);
});

test("saved model NOT in options but same CLI → preserved, injected first", () => {
  const opts = [{ id: "a", label: "A" }];
  const r = resolveModelPicker({ model: "secret", modelCliId: "opencode", cliId: "opencode", options: opts });
  assert.equal(r.model, "secret");
  assert.deepEqual(r.options, [
    { id: "secret", label: "secret" },
    { id: "a", label: "A" },
  ]);
});

test("saved model NOT in options, legacy (no modelCliId) → preserved, injected", () => {
  const opts = [{ id: "a", label: "A" }];
  const r = resolveModelPicker({ model: "secret", modelCliId: "", cliId: "opencode", options: opts });
  assert.equal(r.model, "secret");
  assert.deepEqual(r.options, [
    { id: "secret", label: "secret" },
    { id: "a", label: "A" },
  ]);
});

test("saved model belongs to DIFFERENT CLI → dropped, options unchanged", () => {
  const opts = [{ id: "z", label: "Z" }];
  const r = resolveModelPicker({ model: "gpt-5.4", modelCliId: "codex", cliId: "claude", options: opts });
  assert.equal(r.model, "");
  assert.deepEqual(r.options, opts);
});

test("legacy modelCliId=empty but model present → preserved (treat as same CLI)", () => {
  const opts = [{ id: "a", label: "A" }];
  const r = resolveModelPicker({ model: "x", modelCliId: "", cliId: "claude", options: opts });
  assert.equal(r.model, "x");
  assert.deepEqual(r.options, [
    { id: "x", label: "x" },
    { id: "a", label: "A" },
  ]);
});

test("default options param when omitted", () => {
  const r = resolveModelPicker({ model: "x", modelCliId: "cli", cliId: "cli" });
  assert.equal(r.model, "x");
  assert.deepEqual(r.options, [{ id: "x", label: "x" }]);
});

test("default options param when model is empty", () => {
  const r = resolveModelPicker({ model: "", modelCliId: "", cliId: "cli" });
  assert.equal(r.model, "");
  assert.deepEqual(r.options, []);
});