// 影子卡片接管的选取逻辑 — pickAdoptableRuns 的验收测试。
//
// 背景：/api/events 的帧按 run UUID 索引，工作器卡片按 pool id 键控。
// 别的页签/扩展发起（或本页签刷新后）的单任务只有 active-runs 轮询合成
// 的「处理中」影子卡，接不到步骤流。接管的前提是服务端快照携带 runId
// （见 concurrency-pool.test.mjs 的 shadow-card fix 用例），本函数决定
// 哪些快照条目值得登记进 runId→卡片 的映射。
//
// Run:  node --test tests/lib/job-adopt.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAdoptableRuns } from "../../src/lib/job-adopt.mjs";

const running = (over = {}) => ({
  id: "pool-2", url: "https://x/1", title: "https://x/1", source: "run",
  startedAt: 100, enqueuedAt: 90, ...over,
});
const queued = (over = {}) => ({
  id: "pool-3", url: "https://x/2", title: "https://x/2", source: "run",
  enqueuedAt: 200, position: 1, ...over,
});

test("a running single-run entry with an unmapped runId is adopted with its facts", () => {
  const out = pickAdoptableRuns({ running: [running({ runId: "u1", cliId: "claude" })], queued: [] },
    { mappedRunIds: new Set(), localActiveInputs: new Set() });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    runId: "u1", url: "https://x/1", title: "https://x/1", kind: undefined,
    cliId: "claude", model: undefined, status: "running",
    startedAt: 100, enqueuedAt: 90, queuedPos: undefined,
  });
});

test("the real kind rides along for the adopted card (no more blanket batch-evaluate)", () => {
  const out = pickAdoptableRuns({ running: [running({ runId: "u1", kind: "pdf" })], queued: [] },
    { mappedRunIds: new Set(), localActiveInputs: new Set() });
  assert.equal(out[0].kind, "pdf");
});

test("queued entries are adopted too (the bus registers before the pool grants a slot)", () => {
  const out = pickAdoptableRuns({ running: [], queued: [queued({ runId: "u2" })] },
    { mappedRunIds: new Set(), localActiveInputs: new Set() });
  assert.equal(out.length, 1);
  assert.equal(out[0].status, "queued");
  assert.equal(out[0].startedAt, 200, "a queued card's clock starts at enqueue, not a fake start");
  assert.equal(out[0].queuedPos, 1);
});

test("already-mapped runIds are never re-adopted (idempotent across polls)", () => {
  const out = pickAdoptableRuns({ running: [running({ runId: "u1" })], queued: [] },
    { mappedRunIds: new Set(["u1"]), localActiveInputs: new Set() });
  assert.equal(out.length, 0);
});

test("runIds that already settled on this tab are never rebuilt (terminal guard)", () => {
  // 轮询响应可能晚于 done 事件落地：不拦住就会把定局卡重建成「处理中」。
  const out = pickAdoptableRuns({ running: [running({ runId: "u1" })], queued: [] },
    { mappedRunIds: new Set(), localActiveInputs: new Set(), terminalRunIds: new Set(["u1"]) });
  assert.equal(out.length, 0);
});

test("entries whose URL has a live local card are skipped (dispatch-in-flight window)", () => {
  // The originating tab created its card at startJob; its POST /api/run has not
  // returned the runId yet, so the map cannot guard — the URL must.
  const out = pickAdoptableRuns({ running: [running({ runId: "u1" })], queued: [] },
    { mappedRunIds: new Set(), localActiveInputs: new Set(["https://x/1"]) });
  assert.equal(out.length, 0);
});

test("batch-source and runId-less entries are left as plain shadow cards", () => {
  const out = pickAdoptableRuns({
    running: [running({ source: "batch", runId: "u9" }), running({ id: "pool-4", url: "https://x/4", runId: undefined })],
    queued: [],
  }, { mappedRunIds: new Set(), localActiveInputs: new Set() });
  assert.equal(out.length, 0, "batch workers stream on their own NDJSON; no runId = nothing to join");
});

test("malformed snapshots degrade to no-ops instead of throwing", () => {
  const out = pickAdoptableRuns(undefined, { mappedRunIds: new Set(), localActiveInputs: new Set() });
  assert.deepEqual(out, []);
  const out2 = pickAdoptableRuns({ running: [running({ runId: 42 })], queued: [null] },
    { mappedRunIds: new Set(), localActiveInputs: new Set() });
  assert.equal(out2.length, 0, "non-string runId / null entries are ignored");
});
