// Tests for the status-write failure mapping (ADR-0036): the dropdown must
// explain a failed status change instead of reverting in silence, and the copy
// must not claim more than the server actually knows.
//
// Run:  node --test tests/lib/status-write-error.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeStatusWriteError, offlineStatusWriteError } from "../../src/lib/status-write-error.mjs";

test("a duplicated tracker number points at the repair command", () => {
  const out = describeStatusWriteError(409, { code: "ambiguous", error: "#432 is a duplicate tracker number shared by 2 rows" });
  assert.equal(out.key, "pipeline.statusError.ambiguous");
  // The server's candidate list is deliberately NOT echoed: our own copy says
  // which command fixes it, and the row dump would blow up the header row.
  assert.equal(out.detail, undefined);
});

test("a held tracker lock is transient, not a data problem", () => {
  assert.equal(describeStatusWriteError(503, { code: "lock-timeout", error: "Timed out waiting for tracker lock" }).key, "pipeline.statusError.locked");
  // ...and a bare 503 (no code at all) is the same story.
  assert.equal(describeStatusWriteError(503, null).key, "pipeline.statusError.locked");
});

test("a 503 that carries its own code is not misread as a busy tracker", () => {
  // A data-only root answers {"code":"core-script-missing"} with 503 — keying
  // off the status first would tell the user to retry a failure that never
  // changes on its own.
  const out = describeStatusWriteError(503, {
    code: "core-script-missing",
    error: "status updates need the career-ops scripts; this root has data only",
  });
  assert.equal(out.key, "pipeline.statusError.generic");
  assert.equal(out.detail, "status updates need the career-ops scripts; this root has data only");
});

test("a vanished row is reported as gone", () => {
  assert.equal(describeStatusWriteError(404, { code: "not-found" }).key, "pipeline.statusError.gone");
  assert.equal(describeStatusWriteError(404, null).key, "pipeline.statusError.gone");
});

test("a timeout never claims the write failed", () => {
  const out = describeStatusWriteError(504, { error: "status update timed out; the change may or may not have been applied" });
  assert.equal(out.key, "pipeline.statusError.timeoutUnknown");
  assert.notEqual(out.key, "pipeline.statusError.generic", "must not be boiled down to a plain failure");
});

test("an unrecognized failure carries the server message as one short line", () => {
  // The body's `error` is the route's already-scrubbed message (it refuses to
  // echo the child's stderr); we only flatten and bound it.
  const out = describeStatusWriteError(500, { error: "write-failure\n  while rebuilding row #432" });
  assert.equal(out.key, "pipeline.statusError.generic");
  assert.equal(out.detail, "write-failure while rebuilding row #432");
  assert.ok(!out.detail.includes("\n"), "newlines would break the header row");
});

test("a very long server message is truncated", () => {
  const out = describeStatusWriteError(500, { error: "x".repeat(400) });
  assert.equal(out.detail.length, 161, "160 chars + the ellipsis");
  assert.ok(out.detail.endsWith("…"));
});

test("no body / no message still yields something actionable", () => {
  assert.equal(describeStatusWriteError(500, null).detail, "HTTP 500");
  assert.equal(describeStatusWriteError(500, { error: "   " }).detail, "HTTP 500");
  assert.equal(describeStatusWriteError(500, { code: 42 }).detail, "HTTP 500", "a non-string code is ignored, not coerced");
});

test("a network-level failure has its own message", () => {
  assert.equal(offlineStatusWriteError().key, "pipeline.statusError.offline");
});

test("every key this module can return exists in BOTH languages, and the duplicated-row copy names the fix", () => {
  // Read as text on purpose: the cluster is TypeScript, and a key that only
  // exists in one language renders as the raw key for everyone else.
  const cluster = readFileSync(new URL("../../src/lib/i18n/clusters/pipeline.ts", import.meta.url), "utf8");
  const entries = cluster.split("\n").filter((l) => l.includes('"pipeline.statusError.'));
  const byKey = new Map();
  for (const line of entries) {
    const key = line.match(/"([^"]+)":/)?.[1];
    byKey.set(key, [...(byKey.get(key) ?? []), line]);
  }
  for (const key of [
    "pipeline.statusError.ambiguous",
    "pipeline.statusError.locked",
    "pipeline.statusError.gone",
    "pipeline.statusError.timeoutUnknown",
    "pipeline.statusError.offline",
    "pipeline.statusError.generic",
  ]) {
    assert.equal(byKey.get(key)?.length, 2, `${key} must be defined in both en and zh`);
  }
  // A duplicated tracker number has exactly one way out, so both languages must
  // say which command it is (the ticket's "names the fix action" clause).
  assert.ok(
    byKey.get("pipeline.statusError.ambiguous").every((l) => l.includes("dedup-tracker.mjs")),
    "both languages must point at node dedup-tracker.mjs",
  );
});
