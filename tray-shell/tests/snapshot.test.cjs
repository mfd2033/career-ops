"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSnapshot,
  countStatuses,
  createBusinessFetcher,
  summarizeFollowups,
  summarizeRuns,
} = require("../src/snapshot.cjs");

test("按状态计数：大小写不敏感、未知状态只计入 total", () => {
  const counts = countStatuses([
    { status: "Applied" },
    { status: "applied" },
    { status: "APPLIED" },
    { status: "Responded" },
    { status: "Interview" },
    { status: "Offer" },
    { status: "Evaluated" },
    { status: "Rejected" },
    { status: " Skip " },
    {},
  ]);
  assert.deepEqual(counts, { applied: 3, responded: 1, interview: 1, offer: 1, total: 10 });
});

test("空/异常输入不炸", () => {
  assert.deepEqual(countStatuses(undefined), { applied: 0, responded: 0, interview: 0, offer: 0, total: 0 });
  assert.deepEqual(countStatuses([null, 42, "x"]), { applied: 0, responded: 0, interview: 0, offer: 0, total: 3 });
});

test("跟进：metadata 优先，items 最多 3 条", () => {
  const payload = {
    available: true,
    metadata: { overdue: 2, urgent: 1 },
    entries: [
      { company: "Acme", role: "Staff", urgency: "overdue", num: 12 },
      { company: "Globex", role: "PM", urgency: "urgent", num: 13 },
      { company: "Initech", role: "Lead", urgency: "overdue", num: 14 },
      { company: "Hooli", role: "Dev", urgency: "overdue", num: 15 },
    ],
  };
  const summary = summarizeFollowups(payload);
  assert.equal(summary.due, 3);
  assert.equal(summary.items.length, 3);
  assert.deepEqual(summary.items[0], { company: "Acme", role: "Staff", urgency: "overdue", num: 12 });
});

test("跟进：不可用时给 0 项空列表（面板写「不可用」而不是整块消失）", () => {
  assert.deepEqual(summarizeFollowups({ available: false }), { due: 0, items: [] });
  assert.deepEqual(summarizeFollowups(null), { due: 0, items: [] });
});

test("评估在跑：running / queued 分开计数", () => {
  assert.deepEqual(summarizeRuns({ running: [{}, {}], queued: [{}] }), { running: 2, queued: 1 });
  assert.deepEqual(summarizeRuns(null), { running: 0, queued: 0 });
});

test("快照：state 由 state.cjs 收敛，业务块缺失时保持 null", () => {
  const snapshot = buildSnapshot({
    service: { ready: true, owned: false, healthMs: 38, sha: "abc1234" },
    business: { pipeline: null, followups: null, runs: null, version: null },
  });
  assert.equal(snapshot.service.state, "run");
  assert.equal(snapshot.pipeline, null);
  assert.equal(snapshot.followups, null);
  assert.equal(snapshot.service.sha, "abc1234");
});

test("快照：服务没有版本字段时用 /api/version 的业务副本补齐", () => {
  const snapshot = buildSnapshot({
    service: { ready: true },
    business: { version: { coreVersion: "2.41.0", sha: "05174d5", packaged: true } },
  });
  assert.equal(snapshot.service.coreVersion, "2.41.0");
  assert.equal(snapshot.service.sha, "05174d5");
  assert.equal(snapshot.service.packaged, true);
});

test("业务数据聚合：四路请求各自降级，互不连坐", async () => {
  const fetchJson = async (path) => {
    if (path === "/api/tracker") return { ok: true, json: { ok: true, data: { rows: [{ status: "Applied" }, { status: "Offer" }] } } };
    if (path === "/api/followups") throw new Error("boom");
    if (path === "/api/active-runs") return { ok: true, json: { running: [{}], queued: [] } };
    return { ok: false, json: null };
  };
  const business = await createBusinessFetcher({ fetchJson })();
  assert.deepEqual(business.pipeline, { applied: 1, responded: 0, interview: 0, offer: 1, total: 2 });
  assert.equal(business.followups, null);
  assert.deepEqual(business.runs, { running: 1, queued: 0 });
  assert.equal(business.version, null);
});

test("业务降级：签名带状态码/耗时/错误码，同一坑只报一次", async () => {
  const calls = [];
  const fetchJson = async (path) => {
    if (path === "/api/active-runs") return { ok: true, json: { running: [], queued: [] } };
    return { ok: false, status: 0, json: null, ms: 5000, error: "timeout" };
  };
  const business = createBusinessFetcher({ fetchJson, onDegrade: (signature) => calls.push(signature) });

  await business();
  await business();
  await business();

  assert.equal(calls.length, 1, "同一种降级不重复刷日志");
  assert.match(calls[0], /\/api\/tracker status=0 5000ms error=timeout/);
  assert.match(calls[0], /\/api\/followups/);
  assert.doesNotMatch(calls[0], /active-runs/, "拿到的块不进降级名单");
});
