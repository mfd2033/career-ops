// once-value 单测（ADR-0098 决议 2）：/api/version 的读数额在进程生命周期内只算一次。
//
// WHY: 探针原先每次请求都 execSync(git rev-parse) + 读 4 个文件。web 是单进程单
// 事件循环，**别的路由**一忙，探针自己就先超时——而探针超时会被托盘/扩展读成
// 「服务没起」（ADR-0063 修订三要区分的正是这两种状态）。memo 是这条链路的根，
// 所以它的边界（首次才执行、值同一个、异常不吞、Promise 共享）在这里钉死。
//
// Run:  node --test web/tests/lib/once-value.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOnceValue } from "../../src/lib/once-value.mjs";

test("只在首次调用时执行 compute", () => {
  let runs = 0;
  const read = createOnceValue(() => {
    runs += 1;
    return runs;
  });
  assert.equal(runs, 0, "模块加载/构造阶段不该执行");
  assert.equal(read(), 1);
  assert.equal(read(), 1);
  assert.equal(read(), 1);
  assert.equal(runs, 1);
});

test("返回同一个值（对象是同一引用，不是重建）", () => {
  const read = createOnceValue(() => ({ sha: "abc1234" }));
  assert.equal(read(), read());
});

test("构造时不是函数 → 立即报错（拼错不会静默成空探针）", () => {
  assert.throws(() => createOnceValue(null), TypeError);
  assert.throws(() => createOnceValue("git rev-parse"), TypeError);
});

test("compute 抛错照抛，且不缓存失败结果", () => {
  let attempt = 0;
  const read = createOnceValue(() => {
    attempt += 1;
    if (attempt === 1) throw new Error("git 不可用");
    return "ok";
  });
  assert.throws(() => read(), /git 不可用/);
  // 失败那次没有被记住 → 下一次仍会重试（探针不能因为一次 ENOENT 永久失忆）
  assert.equal(read(), "ok");
  assert.equal(read(), "ok");
  assert.equal(attempt, 2);
});

test("Promise 结果被共享：并发调用只执行一次", async () => {
  let runs = 0;
  const read = createOnceValue(async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "value";
  });
  const [a, b, c] = await Promise.all([read(), read(), read()]);
  assert.deepEqual([a, b, c], ["value", "value", "value"]);
  assert.equal(runs, 1);
});

test("falsy 也算已算过（0 / 空串不会被当成「还没算」重跑）", () => {
  for (const value of [0, "", null, false]) {
    let runs = 0;
    const read = createOnceValue(() => {
      runs += 1;
      return value;
    });
    assert.equal(read(), value);
    assert.equal(read(), value);
    assert.equal(runs, 1);
  }
});
