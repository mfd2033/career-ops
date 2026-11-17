// 工作器停止判定与状态口径的纯函数测试。
// 零 DOM 依赖：入参是 Job 卡的结构化最小形状，组件侧只做事件/动作接线。
//
// Run:  node --test tests/lib/job-stop.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { canRemoveJob, canStopJob, isStopped, jobStatusLabelKey } from "../../src/lib/job-stop.mjs";

const runningLocal = { id: "job-1", status: "running" };
const queuedLocal = { id: "job-2", status: "queued" };
const stoppedLocal = { id: "job-3", status: "error", cancelledByUser: true };

test("canStopJob：本地运行中/排队中卡可停", () => {
  assert.equal(canStopJob(runningLocal), true);
  assert.equal(canStopJob(queuedLocal), true);
});

test("canStopJob：adopt 真卡（有 runId 句柄）可停", () => {
  assert.equal(canStopJob({ id: "adopt-abc", status: "running", runId: "abc" }), true);
});

test("canStopJob：终态卡不可停（只能移除或重试）", () => {
  assert.equal(canStopJob({ id: "job-4", status: "done" }), false);
  assert.equal(canStopJob(stoppedLocal), false);
});

test("canStopJob：池源 running 卡没有服务端句柄，不给停止入口", () => {
  assert.equal(canStopJob({ id: "active-p1", status: "running" }), false);
});

test("canStopJob：池源排队卡可出队", () => {
  assert.equal(canStopJob({ id: "active-p2", status: "queued" }), true);
});

test("isStopped：只认 cancelledByUser，不把普通 error 当已停止", () => {
  assert.equal(isStopped(stoppedLocal), true);
  assert.equal(isStopped({ id: "job-5", status: "error" }), false);
  assert.equal(isStopped(null), false);
});

test("jobStatusLabelKey：用户中断优先于 error 的通用标签", () => {
  assert.equal(jobStatusLabelKey(stoppedLocal), "jobs.statusStopped");
  assert.equal(jobStatusLabelKey({ id: "job-6", status: "error" }), "jobs.statusError");
});

test("jobStatusLabelKey：四种进行/终态各自映射", () => {
  assert.equal(jobStatusLabelKey(runningLocal), "jobs.statusRunning");
  assert.equal(jobStatusLabelKey(queuedLocal), "jobs.queued");
  assert.equal(jobStatusLabelKey({ id: "job-7", status: "done" }), "jobs.statusDone");
  assert.equal(jobStatusLabelKey(null), "jobs.statusError");
});

test("jobStatusLabelKey：已停止的卡即便恢复了 status=running 仍读作已停止", () => {
  // 防御：停止后服务端事件竞态可能迟到把 status 写回；展示口径以标记为准。
  assert.equal(jobStatusLabelKey({ id: "job-8", status: "running", cancelledByUser: true }), "jobs.statusStopped");
});
test("canRemoveJob：只有终态本地卡可移除", () => {
  assert.equal(canRemoveJob(stoppedLocal), true);
  assert.equal(canRemoveJob({ id: "job-9", status: "done" }), true);
  assert.equal(canRemoveJob(runningLocal), false);
  assert.equal(canRemoveJob(queuedLocal), false);
});

test("canRemoveJob：纯台账卡不给移除（删了会被台账合并回来）", () => {
  assert.equal(canRemoveJob({ id: "job-10", status: "error", ledgerOnly: true }), false);
});