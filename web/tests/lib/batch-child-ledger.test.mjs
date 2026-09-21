// Tests for the batch child run-ledger module (ADR-0046) using Node's built-in
// test runner. Imports directly from the .mjs so test and production never drift.
//
// Run:  node --test tests/lib/batch-child-ledger.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { batchChildId, buildBatchChildRecord, batchItemDetailHref } from "../../src/lib/batch-child-ledger.mjs";

test("batchChildId is deterministic and stable across the two call sites", () => {
  const a = batchChildId("batch-1", "https://x/jobs/1");
  assert.equal(a, batchChildId("batch-1", "https://x/jobs/1"), "same inputs -> same id");
  assert.notEqual(a, batchChildId("batch-1", "https://x/jobs/2"), "different key -> different id");
  assert.notEqual(a, batchChildId("batch-2", "https://x/jobs/1"), "different batch -> different id");
});

test("batchChildId is URL-path-segment safe", () => {
  const id = batchChildId("uuid-like-123e4567", "https://weird 站/?a=1&b=2#frag");
  assert.match(id, /^bci-[0-9a-f]+$/, "only [a-z0-9-] so it survives a /jobs/[id] path");
});

test("evaluate child record carries reportNum, not trackerN", () => {
  const rec = buildBatchChildRecord({
    batchId: "b1",
    childKind: "batch-evaluate-item",
    key: "https://x/jobs/1",
    label: "https://x/jobs/1",
    startedAt: 1000,
    finishedAt: 2500,
    cliId: "claude",
    model: "haiku",
    reportNum: 42,
  });
  assert.equal(rec.id, batchChildId("b1", "https://x/jobs/1"));
  assert.equal(rec.parentId, "b1");
  assert.equal(rec.kind, "batch-evaluate-item");
  assert.equal(rec.status, "done");
  assert.equal(rec.reportNum, 42);
  assert.equal("trackerN" in rec, false, "evaluate child has no tracker target");
  assert.equal(rec.model, "haiku");
});

test("checkup child record carries trackerN, not reportNum", () => {
  const rec = buildBatchChildRecord({
    batchId: "b2",
    childKind: "batch-checkup-item",
    key: "917",
    label: "#917 某公司",
    startedAt: 5,
    finishedAt: 9,
    trackerN: "917",
  });
  assert.equal(rec.trackerN, "917");
  assert.equal("reportNum" in rec, false, "checkup child has no report number");
  assert.equal("cliId" in rec, false, "absent engine is not placeholdered");
});

test("batchItemDetailHref: only a known-batch success item is clickable", () => {
  assert.equal(batchItemDetailHref("b1", { key: "https://x/1", ok: true }), `/jobs/${batchChildId("b1", "https://x/1")}`);
  assert.equal(batchItemDetailHref("b1", { key: "https://x/1", ok: false }), null, "failed item has no detail");
  assert.equal(batchItemDetailHref(undefined, { key: "k", ok: true }), null, "no parent batch id -> not clickable");
  assert.equal(batchItemDetailHref("b1", null), null);
});
