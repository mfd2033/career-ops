// Tests for ADR-0042 决议 2's verbatim tool forwarding: summarizeToolInput
// (primary-parameter picking) and parseClaudeEvent's `assistant` path, which is
// the only claude stream-json event carrying a COMPLETED tool_use input — the
// partial `content_block_start` this file already parsed has an empty input.
//
// Run:  node --test tests/lib/tool-detail-forwarding.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeEvent, summarizeToolInput } from "../../src/lib/run-cli-support.mjs";

test("summarizeToolInput picks each tool's primary parameter, verbatim", () => {
  assert.equal(summarizeToolInput("WebFetch", { url: "https://company.com/jobs/1" }), "https://company.com/jobs/1");
  assert.equal(summarizeToolInput("Bash", { command: "node log-checkup.mjs" }), "node log-checkup.mjs");
  assert.equal(summarizeToolInput("Grep", { pattern: "VERDICT", path: "reports/" }), "VERDICT");
  assert.equal(summarizeToolInput("Write", { file_path: "reports/918-a.md", content: "…" }), "reports/918-a.md");
});

test("summarizeToolInput returns null when nothing safe to show", () => {
  assert.equal(summarizeToolInput("TodoWrite", { todos: [] }), null, "no primary key → null");
  assert.equal(summarizeToolInput("UnknownTool", { x: 1 }), null);
  assert.equal(summarizeToolInput("WebFetch", { url: 123 }), null, "non-string value skipped");
  assert.equal(summarizeToolInput("WebFetch", {}), null);
  assert.equal(summarizeToolInput("WebFetch", null), null);
  assert.equal(summarizeToolInput("WebFetch", [1, 2]), null);
});

test("summarizeToolInput truncates long values", () => {
  const long = "a".repeat(500);
  const out = summarizeToolInput("WebFetch", { url: long });
  assert.ok(out.length <= 120);
  assert.ok(out.endsWith("…"));
});

test("assistant event with a tool_use block yields tool + detail", () => {
  const event = parseClaudeEvent(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me fetch the posting." },
          { type: "tool_use", id: "t1", name: "WebFetch", input: { url: "https://company.com/jd" } },
        ],
      },
    }),
  );
  assert.deepEqual(event, { tool: "WebFetch", detail: "https://company.com/jd" });
});

test("assistant event tool_use without a summarizable input keeps the bare tool name", () => {
  const event = parseClaudeEvent(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [] } }] },
    }),
  );
  assert.deepEqual(event, { tool: "TodoWrite" });
});

test("assistant event with no tool_use block stays silent", () => {
  assert.equal(
    parseClaudeEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })),
    null,
  );
});

test("stream_event content_block_start path is unchanged — bare tool name, no detail", () => {
  const event = parseClaudeEvent(
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } },
    }),
  );
  assert.deepEqual(event, { tool: "Bash" });
});
