// 工作器报告号展示的接线守卫（ADR-0089 跟进）。
//
// 症状（2026-11-17 实测）：20:00 之后完成的评估卡在侧栏/列表里没有 #号，硬刷新
// 才恢复。原因是卡片只靠 `input` URL → /api/report-status 索引解析报告号，而该
// 索引建在 applications.md 的 tracker 行上——tracker 合并晚于 run 的 done 事件
// （22:14 完成的 1353，applications.md 到 22:24:46 才写入）。co-job-done 只重取
// 一次索引，那一刻查不到本 run → 卡片永久定格为空号；本地卡还会遮蔽带号的台账卡。
//
// 修法：派发时预占的独占号（服务端 reservedReportNum）随 POST 响应 / 池快照到达
// 客户端，先存进 Job.reservedReportNum，done 事件（诚实门已确认报告落盘）到达时
// 才提升为 Job.reportNum。整条链少任何一环，卡片都会退回「等索引」的旧路。
//
// Run:  node --test tests/lib/worker-report-num-wiring.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const RUN = read("../../src/app/api/run/route.ts");
const STORE = read("../../src/components/jobs/job-store.tsx");
const RETRY = read("../../src/lib/job-retry.mjs");

test("/api/run：POST 响应把本 run 预占的报告号交给客户端", () => {
  assert.match(RUN, /reservedReportNum = num;/);
  assert.match(RUN, /return Response\.json\(\{ runId, title: dispatchLabel \|\| undefined, reportNum: reservedReportNum \}\);/);
});

test("job-store：单任务派发把预占号存成 reservedReportNum（不是直接当报告号）", () => {
  assert.match(STORE, /reportNum\?: number;/);
  assert.match(STORE, /reservedReportNum\?: number;/);
  assert.match(STORE, /reservedReportNum: typeof reportNum === "number" \? reportNum : j\.reservedReportNum/);
});

test("job-store：只有 done 才把预占号提升为报告号（失败/空跑不挂号）", () => {
  assert.match(
    STORE,
    /reportNum:\s*\n\s*status === "done" && j\.reservedReportNum != null \? String\(j\.reservedReportNum\) : j\.reportNum/,
  );
});

test("job-store：接管卡从池快照带上预占号与 #副标题", () => {
  assert.match(STORE, /const subtitle = a\.reportNum != null \? `#\$\{a\.reportNum\}` : undefined;/);
  assert.match(STORE, /reservedReportNum: a\.reportNum,/);
  assert.match(STORE, /input: a\.url, page: "\/jobs" \}/);
});

test("重试：evaluate 的旧号与预占号不跨轮复用，pdf/checkup 保留启动号", () => {
  assert.match(RETRY, /\.\.\.\(job\.kind === "evaluate" \? \{\} : \{ reportNum: job\.reportNum \}\),/);
  assert.equal(/reservedReportNum: job\.reservedReportNum/.test(RETRY), false);
});