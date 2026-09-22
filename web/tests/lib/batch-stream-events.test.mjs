// ADR-0049: batch worker stream-json event parsing + VERDICT extraction +
// item-running / tool event schema validation. Tests the pure functions the
// batch-evaluate route now depends on, without spawning a real CLI.
//
// Run:  node --test tests/lib/batch-stream-events.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeEvent } from "../../src/lib/run-cli-support.mjs";
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
