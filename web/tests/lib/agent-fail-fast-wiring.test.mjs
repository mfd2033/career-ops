// 出错即停的接线守卫（ADR-0094）。
//
// 三条派发路由都没有 DOM/集成测试基建，用源码字符串锁定这条链：
//   致命错误行 → classifyFatalStderr → stopNow → terminateCli(child) → 带原因的终态。
// 少任何一环，「模型额度用尽」就会重新退化成「进程挂着、卡片一直显示运行中」
// （2026-11-03 实测：OpenCode 免费额度耗尽后占满池槽 61 分钟）。
//
// Run:  node --test tests/lib/agent-fail-fast-wiring.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const BATCH_EVAL = read("../../src/app/api/batch-evaluate/route.ts");
const BATCH_CHECKUP = read("../../src/app/api/batch-checkup/route.ts");
const RUN = read("../../src/app/api/run/route.ts");

test("批量评估：stderr 致命行 → 立即终止进程树（不等 close）", () => {
  assert.match(BATCH_EVAL, /import \{[^}]*classifyFatalStderr[^}]*\} from "@\/lib\/run-cli-support\.mjs"/s);
  assert.match(BATCH_EVAL, /const fatal = classifyFatalStderr\(line\);/);
  assert.match(BATCH_EVAL, /stopNow\(fatalStopMessage\(fatal\)\);/);
  assert.match(BATCH_EVAL, /terminateCli\(child\);/);
  // 停机必须立刻结案并拿回池槽，而不是等一个可能永不出现的 close。
  assert.match(BATCH_EVAL, /finish\(\{ cleanExit: false, sawError: true, verdict, errMsg: reason \}\);/);
});

test("批量评估：finish 幂等，防止 close 把已停机的失败覆盖成成功", () => {
  assert.match(BATCH_EVAL, /const finish = \(outcome:[\s\S]{0,600}?if \(settled\) return;/);
});

test("批量评估：补上静默看门狗与总时长阀（此前一道都没有）", () => {
  assert.match(BATCH_EVAL, /const WORKER_KILL_MS = 1_800_000;/);
  assert.match(BATCH_EVAL, /const WORKER_SILENCE_MS = 900_000;/);
  assert.match(BATCH_EVAL, /const armIdle = \(\) => \{/);
  assert.match(BATCH_EVAL, /idle = setTimeout\(/);
  // stdout 与 stderr 的每个 chunk 都要喂它——否则「有一点输出」就永远不算挂死。
  assert.equal((BATCH_EVAL.match(/armIdle\(\);/g) ?? []).length >= 3, true);
});

test("批量评估：停机原因进入子项结果（卡片能说明白为什么停）", () => {
  assert.match(BATCH_EVAL, /errMsg: fatalReason \?\? errMsg/);
});

test("批量体检：同样的致命判定与停机出口", () => {
  assert.match(BATCH_CHECKUP, /classifyFatalStderr,/);
  assert.match(BATCH_CHECKUP, /const fatal = classifyFatalStderr\(line\);/);
  assert.match(BATCH_CHECKUP, /stopNow\(fatalStopMessage\(fatal\)\);/);
  assert.match(BATCH_CHECKUP, /terminateCli\(child\);/);
  assert.match(BATCH_CHECKUP, /const CHECKUP_SILENCE_MS = 900_000;/);
  assert.match(BATCH_CHECKUP, /idle = setTimeout\(/);
  assert.match(BATCH_CHECKUP, /errMsg: fatalReason \?\?/);
});

test("批量体检：finish 幂等（总时长阀与致命停机可能同时到）", () => {
  assert.match(BATCH_CHECKUP, /const finish = \(outcome: CheckupOutcome\) => \{[\s\S]{0,200}?if \(settled\) return;/);
});

test("单任务 /api/run：stderr 与结构化 error 事件都触发停机", () => {
  assert.match(RUN, /classifyFatalStderr,/);
  assert.match(RUN, /const fatal = classifyFatalStderr\(line\);/);
  assert.match(RUN, /const fatal = classifyFatalStderr\(ev\.error\);/);
  assert.match(RUN, /if \(child\) terminateCli\(child\);/);
});

test("单任务 /api/run：死因随终态落账（含 pdf 分支）", () => {
  assert.match(RUN, /fatalReason: stoppedReason/);
  assert.match(RUN, /stoppedReason \? `\$\{stoppedReason\} — \$\{outcome\.message\}` : outcome\.message/);
});
