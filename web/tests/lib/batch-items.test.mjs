// Tests for the batch item registry (ADR-0042 决议 6) using Node's built-in
// test runner. Imports directly from batch-items.mjs (the single source of
// truth) so the test and production code can never drift.
//
// Run:  node --test tests/lib/batch-items.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  completeBatchRun,
  getBatchItems,
  recordBatchItem,
  registerBatchRun,
  __resetBatchItemsForTest,
} from "../../src/lib/batch-items.mjs";

test("register + record + get: the round trip a detail page needs", () => {
  __resetBatchItemsForTest();
  registerBatchRun("b1", { kind: "batch-checkup", total: 3 });
  recordBatchItem("b1", { key: "917", label: "#917 河南蓝辉", ok: true, star: 1.5 });
  recordBatchItem("b1", { key: "918", label: "#918 某", ok: false, skipped: true, reason: "skipped-running" });

  const items = getBatchItems("b1");
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => i.key),
    ["917", "918"],
  );
  assert.equal(items[0].ok, true);
  assert.equal(items[0].star, 1.5);
  // skipped 单列、不算失败（ADR-0041 决议 5 的登记表侧对齐）。
  assert.equal(items[1].skipped, true);
  assert.equal(items[1].ok, false);
});

test("duplicate key rewrite is idempotent — out-of-order/replayed events merge cleanly", () => {
  __resetBatchItemsForTest();
  registerBatchRun("b2", { kind: "batch-evaluate", total: 1 });
  recordBatchItem("b2", { key: "https://x", label: "https://x", ok: false, reason: "hit an error" });
  // A late/重复 conclusion overwrites: the registry reflects the LAST event.
  recordBatchItem("b2", { key: "https://x", label: "https://x", ok: true, score: 4.2 });

  const items = getBatchItems("b2");
  assert.equal(items.length, 1);
  assert.equal(items[0].ok, true);
  assert.equal(items[0].score, 4.2);
  assert.equal(items[0].reason, undefined);
});

test("reportNum passes through evaluate items; absent/non-number stays undefined (ADR-0046)", () => {
  __resetBatchItemsForTest();
  registerBatchRun("b5", { kind: "batch-evaluate", total: 3 });
  // 成功项带真实报告号（写盘的门禁项，num 已在路由侧确认有报告）。
  recordBatchItem("b5", { key: "https://a", label: "https://a", ok: true, score: 4, reportNum: 123 });
  // 失败项无报告，不带 reportNum。
  recordBatchItem("b5", { key: "https://b", label: "https://b", ok: false, reason: "no report" });
  // 非数值的 reportNum 不得作为字符串漏进登记表（读取端会拿它拼 /report/{num}）。
  recordBatchItem("b5", { key: "https://c", label: "https://c", ok: true, reportNum: "bad" });

  const items = getBatchItems("b5");
  assert.equal(items.find((i) => i.key === "https://a").reportNum, 123);
  assert.equal(items.find((i) => i.key === "https://b").reportNum, undefined);
  assert.equal(items.find((i) => i.key === "https://c").reportNum, undefined);
});

test("unknown batchId reads as null, not an empty list", () => {
  __resetBatchItemsForTest();
  // null lets the API answer 404 — "expired/never registered" — instead of a
  // misleading zero-result success.
  assert.equal(getBatchItems("nope"), null);
});

test("registering the same batchId twice keeps the first entry", () => {
  __resetBatchItemsForTest();
  registerBatchRun("b3", { kind: "batch-evaluate", total: 5 });
  registerBatchRun("b3", { kind: "batch-checkup", total: 9 });
  recordBatchItem("b3", { key: "k", label: "k", ok: true });
  assert.equal(getBatchItems("b3").length, 1);
});

test("garbage items are dropped, not stored", () => {
  __resetBatchItemsForTest();
  registerBatchRun("b4", { kind: "batch-evaluate", total: 2 });
  recordBatchItem("b4", null);
  recordBatchItem("b4", { key: "", label: "empty key" });
  recordBatchItem("b4", { key: 42, label: "numeric key" });
  assert.equal(getBatchItems("b4").length, 0);
});

test("completed runs beyond the cap are evicted FIFO; live runs are never evicted", () => {
  __resetBatchItemsForTest();
  const N = 50; // MAX_BATCH_RUNS
  for (let i = 0; i < N; i++) {
    registerBatchRun(`done-${i}`, { kind: "batch-evaluate", total: 1 });
    completeBatchRun(`done-${i}`);
  }
  // One LIVE run interleaved early: it must survive the eviction below.
  registerBatchRun("live", { kind: "batch-evaluate", total: 1 });
  recordBatchItem("live", { key: "k", label: "k", ok: true });
  // One more completed run pushes the count over the cap.
  registerBatchRun("done-extra", { kind: "batch-evaluate", total: 1 });

  assert.equal(getBatchItems("done-0"), null, "oldest completed run evicted");
  assert.notEqual(getBatchItems("live"), null, "live run survives");
  assert.equal(getBatchItems("live")[0].ok, true);
});
