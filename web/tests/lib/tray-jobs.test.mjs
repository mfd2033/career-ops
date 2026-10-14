// 侧栏托盘的卡片选取纯函数 — pickTrayJobs 的验收测试。
//
// 背景：托盘（WorkerPills）以前只渲染本地卡 + 池投影并 slice(0, 6)——
// 跨页签/扩展发起、只活在服务端台账里的终态任务永远进不了托盘（/jobs
// 主列表有 ledgerOnlyRuns 合并，托盘没有）。合并后 6 个名额如何分配是
// 新的决策点：进行中必须永远有位置，终态（本地 + ledger-only）按时间
// 新者优先填剩余名额。
//
// Run:  node --test tests/lib/tray-jobs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTrayJobs } from "../../src/lib/tray-jobs.mjs";

const card = (id, status, startedAt, over = {}) => ({ id, status, startedAt, title: id, steps: [], text: "", ...over });

test("active cards always make the tray, in their original order", () => {
  const jobs = [card("q1", "queued", 500), card("r1", "running", 400), card("d1", "done", 300)];
  const out = pickTrayJobs(jobs, [], 6);
  assert.deepEqual(out.map((j) => j.id), ["q1", "r1", "d1"]);
});

test("settled local and ledger-only cards interleave by recency", () => {
  const jobs = [card("local-old", "done", 100), card("live", "running", 500)];
  const ledger = [card("led-new", "done", 450), card("led-mid", "error", 200)];
  const out = pickTrayJobs(jobs, ledger, 6);
  assert.deepEqual(out.map((j) => j.id), ["live", "led-new", "led-mid", "local-old"]);
});

test("the limit keeps active cards and trims the oldest settled ones", () => {
  const jobs = [card("live", "running", 900), card("d-new", "done", 800), card("d-old", "done", 100)];
  const ledger = [card("led", "done", 500)];
  const out = pickTrayJobs(jobs, ledger, 2);
  assert.deepEqual(out.map((j) => j.id), ["live", "d-new"]);
});

test("active cards beyond the limit still all show (never hide a live worker)", () => {
  // 池满时排队卡可以有很多张——截掉任何一张都是把进行中的工作藏起来。
  const jobs = [card("a1", "running", 5), card("a2", "queued", 4), card("a3", "queued", 3)];
  const out = pickTrayJobs(jobs, [], 1);
  assert.deepEqual(out.map((j) => j.id), ["a1", "a2", "a3"]);
});

test("missing inputs degrade to an empty tray instead of throwing", () => {
  assert.deepEqual(pickTrayJobs(undefined, undefined, 6), []);
});
