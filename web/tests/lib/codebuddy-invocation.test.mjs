// CodeBuddy's headless argv and event parser: the decisions live in
// src/lib/codebuddy-invocation.mjs, the measurements behind them in ADR-0053.
//
// The lines below are hand-written minimal shapes lifted from four real
// captures (22/129/8/8 lines, v2.137.1) — a `file-history-snapshot` and a
// `system/status` line, the two types that are CodeBuddy's own. No capture is
// committed: they carried this machine's absolute paths and skill list.
//
// Run:  node --test tests/lib/codebuddy-invocation.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_KINDS, toolNames, toolScopeFor } from "../../src/lib/claude-invocation.mjs";
import {
  CODEBUDDY_EXTRA_DENIED,
  codebuddyCliArgs,
  codebuddyPermissionFlags,
  parseCodebuddyEvent,
} from "../../src/lib/codebuddy-invocation.mjs";

const PROMPT = "line one\nline two";

const argsFor = (kind) => codebuddyCliArgs({ kind, prompt: PROMPT });
const settingsOf = (args) => JSON.parse(args[args.indexOf("--settings") + 1]);
const denyNames = (kind) => settingsOf(argsFor(kind)).permissions.deny;
const allowNames = (kind) => settingsOf(argsFor(kind)).permissions.allow;

// --- argv shape --------------------------------------------------------------

test("the prompt sits immediately after -p", () => {
  // Not cosmetic: `--allowedTools` is variadic on this CLI, so a positional
  // prompt written after it is swallowed — a run that then emits two lines,
  // `model: "unknown"`, and still exits 0 (measured).
  const args = argsFor("evaluate");
  assert.equal(args[0], "-p");
  assert.equal(args[1], PROMPT);
});

test("the transport flags are the stream-json pair the route parses", () => {
  const args = argsFor("evaluate");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--include-partial-messages"));
});

test("no blanket auto-approve flag ships, in any kind", () => {
  // clis.ts's standing rule. Measured: the allow/deny lists are enough, so
  // asking for more than the audited scope would be a choice, not a need.
  for (const kind of [...KNOWN_KINDS, "anything-unknown"]) {
    const args = argsFor(kind);
    const joined = args.join(" ");
    assert.ok(!args.includes("-y"), `${kind}: -y must not ship`);
    assert.ok(!joined.includes("--dangerously-skip-permissions"), `${kind}: no skip-permissions flag`);
    assert.ok(!joined.includes("bypassPermissions"), `${kind}: no bypass permission mode`);
    assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  }
});

test("the policy travels as --settings JSON, not as two comma-joined flag values", () => {
  // The flags were measured to fail in both directions on this CLI (allow not
  // applied; a deny entry silently ignored while the tool still ran), so a
  // regression to the Claude argv shape is a security regression, not a style
  // change.
  const args = argsFor("pdf");
  assert.ok(!args.includes("--allowedTools"), "flag-form allow must not come back");
  assert.ok(!args.includes("--disallowedTools"), "flag-form deny must not come back");
  assert.ok(args.includes("--settings"));
});

// --- the permission domain stays single-sourced ------------------------------

test("every kind's allow/deny is toolScopeFor(kind), plus the CodeBuddy superset", () => {
  for (const kind of [...KNOWN_KINDS, "unknown-kind"]) {
    const scope = toolScopeFor(kind);
    assert.deepEqual(allowNames(kind), toolNames(scope.allowed), `${kind}: allow drifted from toolScopeFor`);
    const expected = [...new Set([...toolNames(scope.disallowed), ...CODEBUDDY_EXTRA_DENIED])];
    assert.deepEqual(denyNames(kind), expected, `${kind}: deny drifted from toolScopeFor`);
  }
});

test("PowerShell is denied for every kind and never allowed", () => {
  // The measured hole: with `allow:["Read"]` and PowerShell absent from the
  // deny list, the model ran `PowerShell {command:"echo hi"}` successfully.
  // A Windows tool set ships a second shell; denying Bash alone does not
  // confine a read-only kind.
  for (const kind of [...KNOWN_KINDS, "unknown-kind"]) {
    assert.ok(denyNames(kind).includes("PowerShell"), `${kind}: PowerShell must be denied`);
    assert.ok(!allowNames(kind).includes("PowerShell"), `${kind}: PowerShell must never be allowed`);
  }
});

test("the CodeBuddy extras are load-bearing (mutation check)", () => {
  // If the comparison above were vacuous — e.g. the extras silently became an
  // empty list — every assertion would still pass while the engine handed out
  // PowerShell. Demand that at least one denied name is NOT in Claude's lists.
  const claudeNames = new Set(toolNames(toolScopeFor("pdf").disallowed));
  const added = CODEBUDDY_EXTRA_DENIED.filter((t) => !claudeNames.has(t));
  assert.ok(added.includes("PowerShell"), "PowerShell must come from the CodeBuddy extras");
  assert.ok(added.length >= 10, `expected a superset of Claude's tool set, got ${added.length} extras`);
});

// --- the parser delegates, and overrides exactly one field -------------------

const line = (obj) => JSON.stringify(obj);

test("a done line keeps the real token count and drops the fake cost", () => {
  const ev = parseCodebuddyEvent(line({
    type: "result", subtype: "success", is_error: false, result: "DONE",
    usage: { input_tokens: 26270, output_tokens: 15, cache_creation_input_tokens: 23326, cache_read_input_tokens: 2944 },
    total_cost_usd: 0,
  }));
  assert.deepEqual(ev, { tokens: 26270 + 15 + 23326 });
  assert.ok(!("costUsd" in ev), "total_cost_usd is always 0 here — reporting $0.00 claims the run was free");
});

test("a failed done line still reports the tokens it burned", () => {
  const ev = parseCodebuddyEvent(line({
    type: "result", subtype: "error_during_execution", is_error: true, result: "boom",
    usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0,
  }));
  assert.equal(ev.tokens, 15);
  assert.equal(ev.error, "boom");
  assert.ok(!("costUsd" in ev));
});

test("CodeBuddy-only line types carry no step and produce no event", () => {
  assert.equal(parseCodebuddyEvent(line({ type: "file-history-snapshot", id: "x", isSnapshotUpdate: false, snapshot: {} })), null);
  assert.equal(parseCodebuddyEvent(line({ type: "system", subtype: "status", status: "Requesting" })), null);
  assert.equal(parseCodebuddyEvent(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Stdout: hi" }] } })), null);
});

test("the steps a user sees still come through untouched", () => {
  assert.deepEqual(parseCodebuddyEvent(line({ type: "system", subtype: "init", model: "hy3", permissionMode: "acceptEdits" })), { status: "Agent ready" });
  assert.deepEqual(
    parseCodebuddyEvent(line({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DONE" } } })),
    { text: "DONE" },
  );
  assert.deepEqual(
    parseCodebuddyEvent(line({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } } })),
    { tool: "Bash" },
  );
  assert.deepEqual(
    parseCodebuddyEvent(line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi", description: "Print hi" } }] } })),
    { tool: "Bash", detail: "echo hi" },
  );
  // A thinking-only assistant line is not a step either.
  assert.equal(parseCodebuddyEvent(line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "…" }] } })), null);
});

test("junk never throws — it is dropped", () => {
  for (const junk of ["", "not json", "null", "42", '"a string"']) {
    assert.equal(parseCodebuddyEvent(junk), null);
  }
});

test("codebuddyPermissionFlags is what codebuddyCliArgs actually ships", () => {
  // The guard above reads the argv; this pins that the exported helper is the
  // same value, so a caller using it directly cannot diverge from the route.
  for (const kind of KNOWN_KINDS) {
    const flags = codebuddyPermissionFlags(kind);
    const args = argsFor(kind);
    assert.deepEqual(args.slice(args.indexOf("--permission-mode")), flags);
  }
});
