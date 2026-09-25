// 工作器任务重试的判定与重置纯函数测试（ADR-0061 决议 3/4/8）。
// 零 DOM 依赖：入参是 Job 卡的结构化最小形状，组件侧只做事件/动作接线。
//
// Run:  node --test tests/lib/job-retry.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_JOB_KINDS,
  canRetryJob,
  nextAttempt,
  resetJobForRetry,
} from "../../src/lib/job-retry.mjs";

// 本地 error 单任务卡的最小形状。
const singleError = { id: "job-1", status: "error", kind: "evaluate", input: "https://x/a" };

test("批量 kind 清单逐字锁定 — batch-evaluate / batch-checkup", () => {
  assert.deepEqual([...BATCH_JOB_KINDS], ["batch-evaluate", "batch-checkup"]);
});

test("canRetryJob：本地 error 单任务卡可重试", () => {
  assert.equal(canRetryJob(singleError), true);
});

test("canRetryJob：跨会话恢复的 interruptedAt 卡仍是 error 终态，可重试", () => {
  assert.equal(canRetryJob({ ...singleError, interruptedAt: 123 }), true);
});

test("canRetryJob：池源卡（active- 前缀）不可重试", () => {
  assert.equal(canRetryJob({ ...singleError, id: "active-pool-9" }), false);
});

test("canRetryJob：仅 error 终态可重试 — done/queued/running 一律 false", () => {
  for (const status of ["done", "queued", "running"]) {
    assert.equal(canRetryJob({ ...singleError, status }), false, status);
  }
});

test("canRetryJob：批量卡有 urls 或 ns 即可重试", () => {
  const kind = "batch-evaluate";
  assert.equal(canRetryJob({ id: "job-2", status: "error", kind, input: "x", urls: ["https://a"] }), true);
  assert.equal(canRetryJob({ id: "job-2", status: "error", kind, input: "x", ns: ["12"] }), true);
});

test("canRetryJob：批量卡缺 urls/ns 不可重试 — 原始清单无法重建", () => {
  assert.equal(canRetryJob({ id: "job-2", status: "error", kind: "batch-evaluate", input: "x" }), false);
  assert.equal(canRetryJob({ id: "job-2", status: "error", kind: "batch-checkup", input: "x", urls: [], ns: [] }), false);
});

test("canRetryJob：单任务卡缺 kind 或 input 不可重试", () => {
  assert.equal(canRetryJob({ id: "job-3", status: "error", kind: "evaluate" }), false);
  assert.equal(canRetryJob({ id: "job-3", status: "error", input: "https://x" }), false);
});

test("canRetryJob：null/undefined 保守拒绝", () => {
  assert.equal(canRetryJob(null), false);
  assert.equal(canRetryJob(undefined), false);
});

test("nextAttempt：缺省视为第 1 次，重试后是第 2 次", () => {
  assert.equal(nextAttempt({}), 2);
  assert.equal(nextAttempt({ attempt: 1 }), 2);
  assert.equal(nextAttempt({ attempt: 3 }), 4);
});

test("resetJobForRetry：原卡复用——id 与展示/派发字段原样保留", () => {
  const job = {
    id: "job-9",
    title: "evaluate https://x/a",
    subtitle: "公司 · 职位",
    page: "/inbox",
    input: "https://x/a",
    kind: "evaluate",
    cliId: "codex",
    model: "gpt-x",
    reportNum: "042",
    batchId: "b1",
    urls: ["https://x/a"],
    status: "error",
    attempt: 1,
    steps: [{ kind: "status", label: "error: boom", ts: 1 }],
    text: "失败输出",
    result: { score: null, summary: "", tone: "bad" },
    startedAt: 10,
    endedAt: 20,
    runId: "run-old",
    interruptedAt: 30,
    items: [{ key: "k", label: "k", ok: false, ts: 1 }],
    batchPos: { i: 2, n: 3 },
    serverBatchId: "sb-1",
    phase: "finalizing",
    runningStartedAt: 11,
    enqueuedAt: 5,
    queuedPos: 2,
    cost: { tokens: 9 },
  };
  const now = 1000;
  const r = resetJobForRetry(job, { now, separatorLabel: "—— 第 2 次尝试 ——" });
  // 保留：id / 展示字段 / 派发参数快照 / 引擎快照
  assert.equal(r.id, "job-9");
  assert.equal(r.title, "evaluate https://x/a");
  assert.equal(r.subtitle, "公司 · 职位");
  assert.equal(r.page, "/inbox");
  assert.equal(r.input, "https://x/a");
  assert.equal(r.kind, "evaluate");
  assert.equal(r.cliId, "codex");
  assert.equal(r.model, "gpt-x");
  assert.equal(r.reportNum, "042");
  assert.equal(r.batchId, "b1");
  assert.deepEqual(r.urls, ["https://x/a"]);
  // 重置：attempt+1、回 running、startedAt 重置
  assert.equal(r.attempt, 2);
  assert.equal(r.status, "running");
  assert.equal(r.startedAt, now);
  // 时间线：旧步骤保留 + 追加分隔行
  assert.deepEqual(r.steps, [
    { kind: "status", label: "error: boom", ts: 1 },
    { kind: "status", label: "—— 第 2 次尝试 ——", ts: now },
  ]);
  // 清空：输出流是必填字段，重置为空串；其余运行态与结论键整体不存在
  assert.equal(r.text, "");
  for (const k of ["items", "batchPos", "serverBatchId", "result", "cost", "runId", "interruptedAt", "runningStartedAt", "enqueuedAt", "queuedPos", "endedAt", "phase"]) {
    assert.equal(k in r, false, `${k} 应被清除`);
  }
});

test("resetJobForRetry：attempt 从 3 续到 4；steps 缺失时从空数组起", () => {
  const r = resetJobForRetry(
    { id: "job-4", status: "error", kind: "evaluate", input: "x", attempt: 3 },
    { now: 7, separatorLabel: "sep" },
  );
  assert.equal(r.attempt, 4);
  assert.deepEqual(r.steps, [{ kind: "status", label: "sep", ts: 7 }]);
});
