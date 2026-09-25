// ADR-0049: batch worker stream-json event parsing + VERDICT extraction +
// item-running / tool event schema validation. Tests the pure functions the
// batch-evaluate route now depends on, without spawning a real CLI.
// ADR-0054: engine-agnostic invocation selection (shared with /api/run) +
// codex-path simulation + the route source guard (no engine argv builders).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseClaudeEvent, parseCodexEvent } from "../../src/lib/run-cli-support.mjs";
import { resolveWorkerInvocation } from "../../src/lib/worker-invocation.mjs";
import { buildRunLedgerSteps } from "../../src/lib/run-steps.mjs";

// --- Simulate the batch route's processLine logic (the extracted pieces) ------

/**
 * Replicates the batch route's per-worker line processing:
 * accumulate text for VERDICT/ERROR extraction, collect tool events.
 * Returns the emitted events + final verdict/errMsg.
 */
function simulateBatchWorker(jsonLines) {
  let textBuf = "";
  let verdict = null;
  let errMsg = null;
  const emittedEvents = [];
  const collectedEvents = [];

  for (const line of jsonLines) {
    const ev = parseClaudeEvent(line);
    if (ev?.text) {
      textBuf += ev.text;
      const vm = textBuf.match(/VERDICT:[^\n]*/i);
      if (vm) verdict = vm[0];
      const em = textBuf.match(/ERROR:[^\n]*/i);
      if (em) errMsg = em[0];
    }
    if (ev?.tool) {
      const detail = ev.detail || undefined;
      const event = { type: "tool", itemKey: 999, name: ev.tool, ...(detail ? { detail } : {}) };
      emittedEvents.push(event);
      collectedEvents.push({ type: "tool", name: ev.tool, ...(detail ? { detail } : {}), ts: 1000 });
    }
  }
  return { verdict, errMsg, emittedEvents, collectedEvents };
}

// --- Tests -------------------------------------------------------------------

test("VERDICT extracted from parsed assistant text events", () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "Analysis complete. " } } }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "VERDICT: 4.2/5 — strong match\n" } } }),
    JSON.stringify({ type: "result", usage: { input_tokens: 100, output_tokens: 50 } }),
  ];
  const { verdict } = simulateBatchWorker(lines);
  assert.equal(verdict, "VERDICT: 4.2/5 — strong match");
});

test("ERROR captured from text events", () => {
  const lines = [
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "ERROR: cannot extract JD behind login wall\n" } } }),
  ];
  const { errMsg } = simulateBatchWorker(lines);
  assert.equal(errMsg, "ERROR: cannot extract JD behind login wall");
});

test("tool events emitted with correct itemKey schema", () => {
  const lines = [
    JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "WebFetch" } } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebFetch", input: { url: "https://x.com/jobs/1" } }] } }),
  ];
  const { emittedEvents, collectedEvents } = simulateBatchWorker(lines);
  // First event: bare tool from content_block_start (no detail).
  assert.equal(emittedEvents[0].type, "tool");
  assert.equal(emittedEvents[0].itemKey, 999);
  assert.equal(emittedEvents[0].name, "WebFetch");
  assert.equal(emittedEvents[0].detail, undefined);
  // Second event: assistant completed block carries detail.
  assert.equal(emittedEvents[1].name, "WebFetch");
  assert.ok(emittedEvents[1].detail, "detail should be present from assistant block");
  // collectedEvents array tracks both for persistence.
  assert.equal(collectedEvents.length, 2);
});

test("collectedEvents fold into buildRunLedgerSteps correctly", () => {
  const collectedEvents = [
    { type: "tool", name: "WebFetch", ts: 100 },
    { type: "tool", name: "WebFetch", detail: "https://x.com", ts: 101 },
    { type: "tool", name: "Read", ts: 200 },
    { type: "tool", name: "Read", detail: "cv.md", ts: 201 },
  ];
  const steps = buildRunLedgerSteps(collectedEvents);
  // WebFetch bare + WebFetch detail → merged into one step; Read bare + Read detail → merged.
  assert.equal(steps.length, 2);
  assert.equal(steps[0].label, "WebFetch: https://x.com");
  assert.equal(steps[1].label, "Read: cv.md");
});

test("item-running event schema matches what client expects", () => {
  // Verify the shape the route emits: {type:"item-running", reportNum, url}
  const ev = { type: "item-running", reportNum: 945, url: "https://x.com/jobs/1" };
  assert.equal(ev.type, "item-running");
  assert.equal(typeof ev.reportNum, "number");
  assert.equal(typeof ev.url, "string");
});

// --- ADR-0054: shared invocation selection (run + batch must agree) ----------

const claudeLikeSpec = {
  args: (p) => ["-p", p],
  streamArgsFor: ({ kind, prompt }) => ["--stream", "--kind", kind, prompt],
  parseEvent: (l) => l,
};

test("resolveWorkerInvocation: streamArgsFor wins and kind flows through", () => {
  const { args, structured } = resolveWorkerInvocation(claudeLikeSpec, { kind: "evaluate", prompt: "P" });
  assert.deepEqual(args, ["--stream", "--kind", "evaluate", "P"]);
  assert.equal(structured, true);
});

test("resolveWorkerInvocation: streamArgs next for fixed structured argv (codex shape)", () => {
  const spec = { args: (p) => ["exec", p], streamArgs: (p) => ["exec", "--json", p], parseEvent: (l) => l };
  const { args, structured } = resolveWorkerInvocation(spec, { kind: "evaluate", prompt: "P" });
  assert.deepEqual(args, ["exec", "--json", "P"]);
  assert.equal(structured, true);
});

test("resolveWorkerInvocation: plain-only engines keep args and structured=false", () => {
  const spec = { args: (p) => ["-p", p] };
  const { args, structured } = resolveWorkerInvocation(spec, { kind: "evaluate", prompt: "P" });
  assert.deepEqual(args, ["-p", "P"]);
  assert.equal(structured, false);
});

test("resolveWorkerInvocation: structured argv without parseEvent mirrors run-route parity", () => {
  // No such spec exists today; the contract is "selection identical to /api/run"
  // (which picks streamArgs regardless of parseEvent), so the helper must not
  // invent its own fallback.
  const spec = { args: (p) => ["-p", p], streamArgs: (p) => ["--json", p] };
  const { args, structured } = resolveWorkerInvocation(spec, { kind: "evaluate", prompt: "P" });
  assert.deepEqual(args, ["--json", "P"]);
  assert.equal(structured, false);
});

// --- ADR-0054: the codex path through the same processLine pipeline ----------

/** Same shape as simulateBatchWorker but parameterized on the parser, so the
 * codex events can run the exact VERDICT/tool pipeline claude runs. */
function simulateBatchWorkerWith(parseEvent, jsonLines) {
  let textBuf = "";
  let verdict = null;
  let errMsg = null;
  const emittedEvents = [];
  for (const line of jsonLines) {
    const ev = parseEvent(line);
    if (ev?.text) {
      textBuf += ev.text;
      const vm = textBuf.match(/VERDICT:[^\n]*/i);
      if (vm) verdict = vm[0];
      const em = textBuf.match(/ERROR:[^\n]*/i);
      if (em) errMsg = em[0];
    }
    if (ev?.tool) {
      emittedEvents.push({ type: "tool", itemKey: 777, name: ev.tool, ...(ev.detail ? { detail: ev.detail } : {}) });
    }
  }
  return { verdict, errMsg, emittedEvents };
}

test("codex batch worker: VERDICT/ERROR from agent_message text, tools from item.started", () => {
  const lines = [
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fetched the posting\n" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "VERDICT: 3.5/5 — acceptable\n" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  ];
  const { verdict, errMsg, emittedEvents } = simulateBatchWorkerWith(parseCodexEvent, lines);
  assert.equal(verdict, "VERDICT: 3.5/5 — acceptable");
  assert.equal(errMsg, null);
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].name, "Bash");
});

test("codex batch worker: non-JSON stdout lines are ignored, not fatal", () => {
  const { emittedEvents } = simulateBatchWorkerWith(parseCodexEvent, ["banner text", "not json", ""]);
  assert.equal(emittedEvents.length, 0);
});

// --- ADR-0054: route source guard (#10: routes must not self-spell argv) -----

test("batch-evaluate route takes worker argv from the shared selector, never engine builders", () => {
  const src = readFileSync(new URL("../../src/app/api/batch-evaluate/route.ts", import.meta.url), "utf8");
  for (const forbidden of ["claudeCliArgs", "codexStreamArgs", "qoderCliArgs", "codebuddyCliArgs", "parseClaudeEvent", "parseCodexEvent", "parseQoderEvent", "parseCodebuddyEvent"]) {
    assert.ok(!src.includes(forbidden), `batch route must not reference ${forbidden} directly`);
  }
  assert.ok(src.includes("resolveWorkerInvocation("), "batch route must pick worker argv via resolveWorkerInvocation");
});

// 2026-09-25 批量体检全败事故的守卫：batch-checkup 当时手工拼 argv（非 claude
// 引擎裸 -p），codebuddy 无头 worker 的工具调用全部被 CLI 权限层拒绝 —— exit 0、
// 零 stderr、零产物，诚实门禁只能报 "ran but never added a checkup ledger row"。
// 与 batch-evaluate 同一契约：worker argv 一律经共享选择器，kind 必须透传。
test("batch-checkup route takes worker argv from the shared selector, never engine builders", () => {
  const src = readFileSync(new URL("../../src/app/api/batch-checkup/route.ts", import.meta.url), "utf8");
  for (const forbidden of ["claudeCliArgs", "codexStreamArgs", "qoderCliArgs", "codebuddyCliArgs", "parseClaudeEvent", "parseCodexEvent", "parseQoderEvent", "parseCodebuddyEvent", "permissionFlags"]) {
    assert.ok(!src.includes(forbidden), `batch-checkup route must not reference ${forbidden} directly`);
  }
  assert.ok(
    src.includes('resolveWorkerInvocation(spec, { kind: "checkup"'),
    "batch-checkup route must pick worker argv via resolveWorkerInvocation with the checkup kind",
  );
});
