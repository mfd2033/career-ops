// 运行中批量展开态轮询的纯逻辑测试（ADR-0045 决议 8）：登记表快照与本地累积
// 按 key 归并（本地同键胜出）、轮询启停三条件（展开中 ∧ 运行中 ∧ 有登记键）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeBatchItems, shouldPollBatch } from "../../src/lib/batch-live.mjs";

const item = (key, extra = {}) => ({ key, label: key, ok: true, skipped: false, ...extra });

test("mergeBatchItems：按键去重、本地同键覆盖、保持服务端序在前", () => {
  const server = [item("a"), item("b", { ok: false })];
  const local = [item("b", { ok: true, score: 4 }), item("c")];
  const merged = mergeBatchItems(server, local);
  assert.deepEqual(merged.map((i) => i.key), ["a", "b", "c"]);
  assert.equal(merged.find((i) => i.key === "b").ok, true, "本地写入后到、同键胜出");
  assert.equal(merged.find((i) => i.key === "b").score, 4);
});

test("mergeBatchItems：null/缺项/无 key 条目不炸", () => {
  assert.deepEqual(mergeBatchItems(null, undefined), []);
  assert.deepEqual(mergeBatchItems([null, { label: "no-key" }], [undefined, item("z")]).map((i) => i.key), ["z"]);
});

test("shouldPollBatch：展开中 ∧ 运行中 ∧ 有 serverBatchId 才拉", () => {
  assert.equal(shouldPollBatch({ open: true, running: true, serverBatchId: "b1" }), true);
  assert.equal(shouldPollBatch({ open: false, running: true, serverBatchId: "b1" }), false, "折叠不轮询");
  assert.equal(shouldPollBatch({ open: true, running: false, serverBatchId: "b1" }), false, "终态停止轮询");
  assert.equal(shouldPollBatch({ open: true, running: true, serverBatchId: null }), false, "无登记键无从拉取");
  assert.equal(shouldPollBatch({}), false);
});
