// events-bus-pure 纯逻辑单测：扩展侧的「一条共享 /api/events 连接，按 runId 分发」。
//
// 为什么需要它：改造前每次单职位评估都各自 fetch 一条 /api/events，而服务端那条
// 总线本来就是多路复用（ADR-0020，帧里带 runId 与单调 seq）。浏览器对同一 origin
// 只有 6 条 HTTP/1.1 连接，几条评估叠上快评/批量就能把池占满 —— 探针连 socket 都
// 拿不到，6s 后 abort，扩展报「服务在忙」，服务其实 1-3ms 就能答。
//
// Run:  node --test web/tests/lib/events-bus-pure.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "events-bus-pure.js")).href);
const { createBus, isRunFrame } = mod.default ?? mod;

const frame = (runId, seq, type = "status") => ({ runId, ev: { type, seq } });

test("帧只投给自己的 runId，不串台", () => {
  const bus = createBus();
  const a = [];
  const b = [];
  bus.subscribe("run-a", (f) => a.push(f.ev.seq));
  bus.subscribe("run-b", (f) => b.push(f.ev.seq));

  bus.publish(frame("run-a", 1));
  bus.publish(frame("run-b", 2));
  bus.publish(frame("run-a", 3));

  assert.deepEqual(a, [1, 3]);
  assert.deepEqual(b, [2]);
});

test("没有订阅者的 run 的帧不会报错，但会被缓冲以支持后订阅", () => {
  const bus = createBus();
  bus.publish(frame("run-x", 1));
  const got = [];
  bus.subscribe("run-x", (f) => got.push(f.ev.seq));
  assert.deepEqual(got, [1], "订阅前到达的帧必须回放，否则先 POST /api/run 后订阅会丢掉开头几帧");
});

test("keepalive / 畸形帧被丢弃，且不进入缓冲", () => {
  const bus = createBus();
  assert.equal(isRunFrame({ type: "keepalive" }), false);
  assert.equal(isRunFrame({ runId: "r" }), false, "缺 ev");
  assert.equal(isRunFrame(null), false);

  assert.equal(bus.publish({ type: "keepalive" }), "keepalive");
  assert.equal(bus.publish({ runId: "r" }), "ignored");
  assert.equal(bus.subscribers(), 0);

  const got = [];
  bus.subscribe("r", (f) => got.push(f));
  assert.deepEqual(got, []);
});

test("seq 去重：重连后服务端整段回放不会重复投递", () => {
  const bus = createBus();
  const got = [];
  bus.subscribe("r", (f) => got.push(f.ev.seq));

  bus.publish(frame("r", 1));
  bus.publish(frame("r", 2));
  // 模拟通道断开重连：服务端 replay 全部历史 + 继续推新帧。
  bus.publish(frame("r", 1));
  bus.publish(frame("r", 2));
  bus.publish(frame("r", 3));

  assert.deepEqual(got, [1, 2, 3]);
});

test("没有 seq 的帧不去重（宁可重复也不丢）", () => {
  const bus = createBus();
  const got = [];
  bus.subscribe("r", (f) => got.push(f.ev.type));
  bus.publish({ runId: "r", ev: { type: "text" } });
  bus.publish({ runId: "r", ev: { type: "text" } });
  assert.deepEqual(got, ["text", "text"]);
});

test("退订后不再收到，重复退订无害", () => {
  const bus = createBus();
  const got = [];
  const off = bus.subscribe("r", (f) => got.push(f.ev.seq));
  bus.publish(frame("r", 1));
  off();
  off();
  bus.publish(frame("r", 2));
  assert.deepEqual(got, [1]);
  assert.equal(bus.subscribers(), 0);
});

test("单个 run 的缓冲只留尾部，不受长任务 text 洪流拖垮", () => {
  const bus = createBus({ maxFramesPerRun: 3 });
  const got = [];
  for (let seq = 1; seq <= 6; seq++) bus.publish(frame("r", seq));
  bus.subscribe("r", (f) => got.push(f.ev.seq));
  assert.deepEqual(got, [4, 5, 6], "回放的是最近 3 帧");
});

test("run 记录本身有上限，先完成的旧 run 先出局", () => {
  const bus = createBus({ maxRuns: 2 });
  bus.publish(frame("r1", 1));
  bus.publish(frame("r2", 1));
  bus.publish(frame("r3", 1));
  assert.equal(bus.runs(), 2);
  const got = [];
  bus.subscribe("r3", (f) => got.push(f));
  assert.equal(got.length, 1, "最新的 run 一定还在");
});

test("failAll 把通道错误发给每个在场的订阅者", () => {
  const bus = createBus();
  const errs = [];
  bus.subscribe("a", (f) => errs.push(f.error || null));
  bus.subscribe("b", (f) => errs.push(f.error || null));
  bus.failAll("事件通道断了");
  assert.deepEqual(errs, ["事件通道断了", "事件通道断了"]);
});

test("一对多：同一 run 的多个订阅者都收到", () => {
  const bus = createBus();
  const one = [];
  const two = [];
  bus.subscribe("r", (f) => one.push(f.ev.seq));
  bus.subscribe("r", (f) => two.push(f.ev.seq));
  bus.publish(frame("r", 7));
  assert.deepEqual(one, [7]);
  assert.deepEqual(two, [7]);
  assert.equal(bus.subscribers(), 2);
});
