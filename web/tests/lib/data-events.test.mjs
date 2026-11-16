// data-events 单测（ADR-0101）：变更总线的扇出规则与帧形状。
//
// WHY: 这条总线决定「扩展改完状态，已打开的管道页要不要重取」。规则错了有两种代价：
// 帧带 runId → 撞上用同一通道的 worker 事件；订阅者泄漏 → 关掉的标签页在服务进程里
// 留一个死 controller；发布点抛错 → 一次已经落盘的写被报成 500。
//
// Run:  node --test web/tests/lib/data-events.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATA_SCOPE_TRACKER,
  dataChangeFrame,
  publishDataChange,
  subscribeDataChanges,
  dataChangeSubscriberCount,
  __resetDataEventsForTest,
} from "../../src/lib/data-events.mjs";

test("publish 扇出到所有订阅者，带 scope 与服务端时刻", () => {
  __resetDataEventsForTest();
  const a = [];
  const b = [];
  const offA = subscribeDataChanges((c) => a.push(c));
  const offB = subscribeDataChanges((c) => b.push(c));

  publishDataChange(DATA_SCOPE_TRACKER);

  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].scope, DATA_SCOPE_TRACKER);
  assert.equal(typeof a[0].ts, "number");
  offA();
  offB();
});

test("退订后不再收到；重复退订不抛错", () => {
  __resetDataEventsForTest();
  const seen = [];
  const off = subscribeDataChanges((c) => seen.push(c));
  publishDataChange(DATA_SCOPE_TRACKER);
  off();
  off();
  publishDataChange(DATA_SCOPE_TRACKER);

  assert.equal(seen.length, 1);
  assert.equal(dataChangeSubscriberCount(), 0);
});

test("一个订阅者抛错不影响其它订阅者", () => {
  __resetDataEventsForTest();
  const seen = [];
  const offBad = subscribeDataChanges(() => {
    throw new Error("controller 已经关了");
  });
  const offGood = subscribeDataChanges((c) => seen.push(c));

  assert.doesNotThrow(() => publishDataChange(DATA_SCOPE_TRACKER));
  assert.equal(seen.length, 1);
  offBad();
  offGood();
});

test("空 scope / 非字符串被静默丢弃（发布点不该崩掉一次已落盘的写）", () => {
  __resetDataEventsForTest();
  const seen = [];
  const off = subscribeDataChanges((c) => seen.push(c));

  for (const bad of ["", "   ", null, undefined, 0, {}]) {
    assert.doesNotThrow(() => publishDataChange(bad));
  }
  assert.equal(seen.length, 0);
  off();
});

test("帧形状：type=data-changed 且不带 runId（旧客户端按无 runId 帧忽略）", () => {
  const frame = dataChangeFrame(DATA_SCOPE_TRACKER, 1234);
  assert.deepEqual(frame, { type: "data-changed", scope: DATA_SCOPE_TRACKER, ts: 1234 });
  assert.equal("runId" in frame, false);
  assert.equal("ev" in frame, false);
  assert.equal(typeof dataChangeFrame(DATA_SCOPE_TRACKER).ts, "number");
});

test("detail 并入变更对象，但不污染 scope", () => {
  __resetDataEventsForTest();
  const seen = [];
  const off = subscribeDataChanges((c) => seen.push(c));

  publishDataChange(DATA_SCOPE_TRACKER, { origin: "api/status" });

  assert.equal(seen[0].origin, "api/status");
  assert.equal(seen[0].scope, DATA_SCOPE_TRACKER);
  off();
});
