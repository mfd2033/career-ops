// 体检在跑登记表的契约测试（ADR-0033 决议 2/6）。
//
// 要锁住的三件事：① 「本行此刻有没有体检在跑」在 queued 与 running 两种状态下都为真
// （排队中的体检必须被拦下，它才是最便宜的一次取消）；② run 的终态与进程的死是两件事
// —— 取消后闸门必须立刻放开，但替换路径仍要能等到进程真的不在；③ 等不到进程时返回
// 「不确定」（timeout），既不能当「已死」，也不能把已经结束的条目当错误。
//
// Run:  node --test web/tests/lib/checkup-live.test.mjs
//
// 本套件共享模块级状态，每个用例前必须重置（checkup-live 的 test hook）。

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerCheckup,
  markCheckupRunning,
  clearCheckup,
  listLiveCheckups,
  attachCheckupExit,
  awaitCheckupGone,
  __resetCheckupLiveForTest,
} from "../../src/lib/checkup-live.mjs";

beforeEach(() => __resetCheckupLiveForTest());

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const T0 = 1789700000000;

test("空表：没有登记的 tracker# 查询为空，等死是 unknown", async () => {
  assert.deepEqual(listLiveCheckups("917"), []);
  assert.equal(await awaitCheckupGone("917", "run-1", 5), "unknown");
});

test("派发即登记，初始状态是 queued（登记发生在进入并发池之前）", () => {
  registerCheckup("917", "run-917");
  assert.deepEqual(listLiveCheckups("917"), [{ runId: "run-917", state: "queued", startedAt: null }]);
});

test("拿到池槽后翻成 running 并记下开始时刻", () => {
  registerCheckup("917", "run-917");
  markCheckupRunning("917", "run-917", T0);
  assert.deepEqual(listLiveCheckups("917"), [{ runId: "run-917", state: "running", startedAt: T0 }]);
});

test("排队中的体检也算「在跑」（前哨据此拦下按钮）", () => {
  registerCheckup("917", "queued-one");
  assert.deepEqual(
    listLiveCheckups("917").map((e) => e.state),
    ["queued"],
  );
});

test("终态清除把条目移出在跑列表（闸门立刻放开），重复清除与清除未知条目都是 no-op", () => {
  registerCheckup("917", "run-917");
  clearCheckup("917", "run-917", { processGone: true });
  clearCheckup("917", "run-917");
  assert.doesNotThrow(() => clearCheckup("917", "never-registered"));
  assert.deepEqual(listLiveCheckups("917"), []);
});

test("取消一个正在跑的 run：闸门立刻放开，但等死仍要等到进程退出", async () => {
  const exit = deferred();
  registerCheckup("917", "run-917");
  markCheckupRunning("917", "run-917", T0);
  attachCheckupExit("917", "run-917", exit.promise);

  // taskkill 是 fire-and-forget：run 已终态（前哨不该再拦），进程还没确认死。
  clearCheckup("917", "run-917", { processGone: false });
  assert.deepEqual(listLiveCheckups("917"), [], "终态后前哨不再拦——它能立刻再派一个");

  const waiting = awaitCheckupGone("917", "run-917", 1000);
  exit.resolve(0);
  assert.equal(await waiting, "gone", "替换路径仍能等到进程真的不在");
});

test("排队中被取消（本就没有进程）：等死直接是 unknown（按已停处理）", async () => {
  registerCheckup("917", "run-917");
  clearCheckup("917", "run-917", { processGone: true });
  assert.equal(await awaitCheckupGone("917", "run-917", 1000), "unknown");
});

test("同一 tracker# 可以有多条在跑条目（替换动作据此「停全部」）", () => {
  registerCheckup("917", "run-a");
  registerCheckup("917", "run-b");
  assert.deepEqual(
    listLiveCheckups("917").map((e) => e.runId),
    ["run-a", "run-b"],
  );
  clearCheckup("917", "run-a", { processGone: true });
  assert.deepEqual(
    listLiveCheckups("917").map((e) => e.runId),
    ["run-b"],
  );
});

test("同 (tracker#, runId) 重复登记幂等（不重置状态，也不重置 gone 信号）", () => {
  registerCheckup("917", "run-917");
  markCheckupRunning("917", "run-917", T0);
  registerCheckup("917", "run-917");
  assert.deepEqual(listLiveCheckups("917"), [{ runId: "run-917", state: "running", startedAt: T0 }]);
});

test("不同 tracker# 互不影响（#91 不命中所属 #917 的条目）", () => {
  registerCheckup("917", "run-917");
  assert.deepEqual(listLiveCheckups("91"), []);
  clearCheckup("91", "run-917", { processGone: true });
  assert.equal(listLiveCheckups("917").length, 1);
});

test("子进程退出后等死返回 gone（挂上 exit 信号再等）", async () => {
  const exit = deferred();
  registerCheckup("917", "run-917");
  attachCheckupExit("917", "run-917", exit.promise);
  const waiting = awaitCheckupGone("917", "run-917", 1000);
  exit.resolve(0);
  assert.equal(await waiting, "gone");
});

test("spawn 失败（exit 信号 reject）同样算不在", async () => {
  const exit = deferred();
  registerCheckup("917", "run-917");
  attachCheckupExit("917", "run-917", exit.promise);
  const waiting = awaitCheckupGone("917", "run-917", 1000);
  exit.reject(new Error("spawn failed"));
  assert.equal(await waiting, "gone");
});

test("超时不等于已死：等不到就返回 timeout，条目仍在跑", async () => {
  registerCheckup("917", "run-917");
  attachCheckupExit("917", "run-917", deferred().promise);
  assert.equal(await awaitCheckupGone("917", "run-917", 10), "timeout");
  assert.equal(listLiveCheckups("917").length, 1, "超时后登记不变——它仍在跑，只是没确认死");
});

test("已 gone 的条目立即返回 gone，不再等超时", async () => {
  const exit = deferred();
  registerCheckup("917", "run-917");
  attachCheckupExit("917", "run-917", exit.promise);
  exit.resolve(0);
  assert.equal(await awaitCheckupGone("917", "run-917", 1000), "gone");
});

test("给未知条目挂 exit 信号是 no-op（不抛错、不凭空造条目）", () => {
  assert.doesNotThrow(() => attachCheckupExit("917", "never-registered", deferred().promise));
  assert.deepEqual(listLiveCheckups("917"), []);
});

test("快照是拷贝，调用方改动不影响登记表", () => {
  registerCheckup("917", "run-917");
  const snap = listLiveCheckups("917");
  snap[0].runId = "tampered";
  snap.push({ runId: "ghost", state: "running", startedAt: 0 });
  assert.deepEqual(
    listLiveCheckups("917").map((e) => e.runId),
    ["run-917"],
  );
});

test("墓碑有界：kill 不掉、永不退出的进程不会让登记表无限长大", async () => {
  // 65 个取消后未确认死掉的条目 —— 超上限即淘汰最老的墓碑（之后的等待退化为 unknown，
  // 按「已停」处理，等同于没有登记表时的行为）。
  for (let i = 0; i < 65; i += 1) {
    const exit = deferred(); // 永不 resolve
    registerCheckup("917", `run-${i}`);
    attachCheckupExit("917", `run-${i}`, exit.promise);
    clearCheckup("917", `run-${i}`, { processGone: false });
  }
  assert.equal(await awaitCheckupGone("917", "run-0", 5), "unknown", "最老的墓碑已被淘汰");
  assert.equal(await awaitCheckupGone("917", "run-64", 5), "timeout", "最新的仍在等");
});
