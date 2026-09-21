// /jobs 历史页台账合并去重的纯函数测试（ADR-0045 推定结论）：
// 单次 run 凭 runId 去重（既有行为不回退），批量凭 open 事件下发的 serverBatchId
// 去重 —— 同一批量本地卡胜出，台账行不生成重复 ledger-only 行。

import { test } from "node:test";
import assert from "node:assert/strict";
import { ledgerOnlyRuns } from "../../src/lib/ledger-merge.mjs";

const row = (id, extra = {}) => ({ id, kind: "evaluate", title: id, status: "done", startedAt: 1, finishedAt: 2, ...extra });

test("无本地卡时台账行全量保留", () => {
  const runs = [row("r1"), row("r2")];
  assert.deepEqual(ledgerOnlyRuns([], runs).map((r) => r.id), ["r1", "r2"]);
});

test("单次 run：本地卡 runId 命中的台账行被去重", () => {
  const jobs = [{ id: "local-1", runId: "r1" }];
  const runs = [row("r1"), row("r2")];
  assert.deepEqual(ledgerOnlyRuns(jobs, runs).map((r) => r.id), ["r2"]);
});

test("批量：本地卡 serverBatchId 命中的台账行被去重（同批量绝不出双行）", () => {
  const jobs = [{ id: "local-b", serverBatchId: "b-9", kind: "batch-evaluate" }];
  const runs = [row("b-9", { kind: "batch-evaluate", items: [], total: 2 }), row("r-other")];
  const out = ledgerOnlyRuns(jobs, runs);
  assert.deepEqual(out.map((r) => r.id), ["r-other"]);
});

test("ADR-0046：带 parentId 的子任务行不进列表（仅父行保留）", () => {
  const runs = [
    row("b-9", { kind: "batch-evaluate", items: [], total: 2 }),
    row("bci-aaa", { parentId: "b-9", kind: "batch-evaluate-item" }),
    row("bci-bbb", { parentId: "b-9", kind: "batch-evaluate-item" }),
    row("r-single"),
  ];
  // 无本地卡时：父批量行与单次行保留，两条子行被排除。
  assert.deepEqual(ledgerOnlyRuns([], runs).map((r) => r.id), ["b-9", "r-single"]);
});

test("缺 id / 畸形行不进 ledger-only 结果", () => {
  const runs = [row(""), row(undefined), { kind: "evaluate" }, row("ok")];
  assert.deepEqual(ledgerOnlyRuns([], runs).map((r) => r.id), ["ok"]);
});

test("入参容错：jobs / ledgerRuns 任一缺失不抛", () => {
  assert.deepEqual(ledgerOnlyRuns(undefined, [row("r1")]).map((r) => r.id), ["r1"]);
  assert.deepEqual(ledgerOnlyRuns([{ id: "j" }], undefined), []);
});
