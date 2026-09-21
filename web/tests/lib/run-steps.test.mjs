// 事件→步骤折叠的形状与归并口径锁定（ADR-0047 决议 2）。核心是「重建的时间线」
// 必须与 job-store 实时累积逐字对齐：工具/状态筛选、phase 排除、同名 detail 就地
// 并入、无裸行时 detail 丢弃、cap 截尾、label 截断、ts 透传、空输入不抛。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunLedgerSteps, RUN_STEPS_CAP, RUN_STEP_LABEL_MAX } from "../../src/lib/run-steps.mjs";

test("只纳入 tool / status；text / done / error / item 不进", () => {
  const steps = buildRunLedgerSteps([
    { type: "text", text: "hi" },
    { type: "tool", name: "Read" },
    { type: "status", label: "working" },
    { type: "done", tokens: 10 },
    { type: "error", msg: "boom" },
    { type: "item", url: "u", ok: true },
  ]);
  assert.deepEqual(steps.map((s) => s.kind), ["tool", "status"]);
  assert.equal(steps[0].label, "Read");
  assert.equal(steps[1].label, "working");
});

test("phase: 前缀的 status 被排除（粗阶段徽章不入步骤流）", () => {
  const steps = buildRunLedgerSteps([
    { type: "status", label: "phase:queued" },
    { type: "status", label: "phase:running" },
    { type: "status", label: "phase:finalizing:render" },
    { type: "status", label: "真实进度行" },
  ]);
  assert.deepEqual(steps.map((s) => s.label), ["真实进度行"]);
});

test("同名工具：带 detail 的事件就地并入裸行，一次调用一行", () => {
  const steps = buildRunLedgerSteps([
    { type: "tool", name: "WebFetch" },
    { type: "tool", name: "WebFetch", detail: "https://x.com/jobs/1" },
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "WebFetch: https://x.com/jobs/1");
});

test("无匹配裸行时 detail 丢弃（与客户端一致：只 push name）", () => {
  const steps = buildRunLedgerSteps([{ type: "tool", name: "Grep", detail: "pattern" }]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "Grep");
});

test("两次独立同名调用各自成行（第二条裸行仍可被第二条 detail 并入）", () => {
  const steps = buildRunLedgerSteps([
    { type: "tool", name: "Read" },
    { type: "tool", name: "Read", detail: "a.md" },
    { type: "tool", name: "Read" },
    { type: "tool", name: "Read", detail: "b.md" },
  ]);
  assert.deepEqual(steps.map((s) => s.label), ["Read: a.md", "Read: b.md"]);
});

test("cap：超过上限保留最近 N 条（尾部优先）", () => {
  const events = Array.from({ length: RUN_STEPS_CAP + 10 }, (_, i) => ({ type: "status", label: `s${i}` }));
  const steps = buildRunLedgerSteps(events);
  assert.equal(steps.length, RUN_STEPS_CAP);
  assert.equal(steps[0].label, `s${10}`);
  assert.equal(steps[steps.length - 1].label, `s${RUN_STEPS_CAP + 9}`);
});

test("label 截断到 labelMax（含 detail 的长行不撑爆台账）", () => {
  const long = "x".repeat(500);
  const steps = buildRunLedgerSteps([
    { type: "tool", name: "Write" },
    { type: "tool", name: "Write", detail: long },
  ]);
  assert.equal(steps.length, 1);
  assert.ok(steps[0].label.length <= RUN_STEP_LABEL_MAX, `label 应被截断，实际 ${steps[0].label.length}`);
  assert.ok(steps[0].label.startsWith("Write: "));
});

test("ts 透传；无 ts 时省略字段（不回填假时间）", () => {
  const steps = buildRunLedgerSteps([
    { type: "tool", name: "Read", ts: 111 },
    { type: "status", label: "no-ts" },
  ]);
  assert.equal(steps[0].ts, 111);
  assert.ok(!("ts" in steps[1]), "无 ts 不得占位");
});

test("空 / 非数组输入返回空数组，绝不抛", () => {
  assert.deepEqual(buildRunLedgerSteps([]), []);
  assert.deepEqual(buildRunLedgerSteps(undefined), []);
  assert.deepEqual(buildRunLedgerSteps(null), []);
  assert.deepEqual(buildRunLedgerSteps([null, {}, { type: 1 }]), []);
});
