// 批量 run 台账落盘的形状锁定测试（ADR-0045 决议 2/5/6 + 推定结论）：
// 记录形状（id=serverBatchId、status 双态、total 保留）、items 快照 cap 100
// （溢出只记 total 不丢计数）、msg 截断、与 run-ledger 的 append→read 回环，
// 以及缺 items 的旧台账行仍能解析（tolerant reader）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunRecord, readRunHistory } from "../../src/lib/run-ledger.mjs";
import { buildBatchLedgerRecord, BATCH_LEDGER_ITEMS_CAP } from "../../src/lib/batch-ledger.mjs";

const base = {
  batchId: "b-1",
  kind: "batch-evaluate",
  title: "批量评估 · 3 项",
  input: "https://a.com/jobs/1 +2",
  startedAt: 1000,
  total: 3,
  status: "done",
  cliId: "claude",
  model: "m1",
  items: [],
};

test("record shape: serverBatchId is the run id, terminal fields present", () => {
  const rec = buildBatchLedgerRecord({ ...base, items: [{ key: "u", label: "u", ok: true, skipped: false, score: 4, star: null, ts: 1100 }] });
  assert.equal(rec.id, "b-1");
  assert.equal(rec.kind, "batch-evaluate");
  assert.equal(rec.status, "done");
  assert.equal(rec.startedAt, 1000);
  assert.ok(rec.finishedAt >= rec.startedAt);
  assert.equal(rec.total, 3);
  assert.equal(rec.items.length, 1);
  assert.equal(rec.cliId, "claude");
  assert.equal(rec.model, "m1");
});

test("cliId/model 空串不占位（读取端按未记录处理）", () => {
  const rec = buildBatchLedgerRecord({ ...base, cliId: "", model: "" });
  assert.ok(!rec.cliId);
  assert.ok(!rec.model);
});

test("items 快照 cap 100，溢出时 total 保留完整计数", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, ok: true, skipped: false }));
  const rec = buildBatchLedgerRecord({ ...base, total: 120, items: many });
  assert.equal(rec.items.length, BATCH_LEDGER_ITEMS_CAP);
  assert.equal(rec.items[0].key, "k0"); // 保序取前 100（批量按写入序）
  assert.equal(rec.total, 120);
});

test("msg 截断到 800（与单次 run recordEnd 同口径）", () => {
  const rec = buildBatchLedgerRecord({ ...base, status: "error", msg: "x".repeat(2000) });
  assert.equal(rec.msg.length, 800);
});

test("非数组 items 归一为空数组（defensive，绝不抛）", () => {
  assert.deepEqual(buildBatchLedgerRecord({ ...base, items: undefined }).items, []);
});

test("append→read 回环：批量行带 items/total 原样读出；旧行缺字段仍可解析", () => {
  const root = mkdtempSync(join(tmpdir(), "co-bledger-"));
  try {
    // 一条功能前的旧台账行（无 items/total）
    appendRunRecord(root, { id: "old", kind: "evaluate", input: "u", title: "t", status: "done", startedAt: 1, finishedAt: 2 });
    appendRunRecord(root, buildBatchLedgerRecord({ ...base, status: "error", msg: "Batch cancelled.", items: [{ key: "k", label: "k", ok: false, skipped: false, reason: "cancelled" }] }));
    const [batchRow, oldRow] = readRunHistory(root);
    assert.equal(batchRow.id, "b-1");
    assert.equal(batchRow.status, "error");
    assert.equal(batchRow.msg, "Batch cancelled.");
    assert.equal(batchRow.total, 3);
    assert.equal(batchRow.items[0].reason, "cancelled");
    assert.equal(oldRow.id, "old");
    assert.ok(!("items" in oldRow), "旧行不得被回填 items");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
