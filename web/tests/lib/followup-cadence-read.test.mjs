// followup-cadence-read 纯逻辑单测：core `followup-cadence.mjs --json` 的 stdout
// → JSON 载荷的解析（ADR-0075 决议 7；房规 ADR-0050）。
// 它是「现实 stdout」与「可用载荷」之间的唯一分拣口：噪声前缀要能穿过，
// 解析不出来一律 null——调用方据此 fail-closed（报告页入口隐藏、路由回
// available:false），绝不抛错。
//
// Run:  node --test web/tests/lib/followup-cadence-read.test.mjs
//
// 放在 web/tests/lib 同族纯逻辑测试之间，由 test-all.mjs 的 web/tests/lib
// 批次自动一并门住（目录级 glob，无需登记）。

import test from "node:test";
import assert from "node:assert/strict";
import { parseCadenceStdout } from "../../src/lib/followup-cadence-read.mjs";

// ---- 可用载荷 -------------------------------------------------------------

test("干净的 JSON stdout：metadata / entries / cadenceConfig 原样带出", () => {
  const stdout = JSON.stringify({
    metadata: { actionable: 3, overdue: 1 },
    entries: [{ num: 1133, company: "双汇发展" }],
    cadenceConfig: { applied_first: 7 },
  });
  assert.deepEqual(parseCadenceStdout(stdout), {
    metadata: { actionable: 3, overdue: 1 },
    entries: [{ num: 1133, company: "双汇发展" }],
    cadenceConfig: { applied_first: 7 },
  });
});

test("噪声前缀：从第一个 { 起解析（CLI 可能先打 warning 行）", () => {
  const stdout = 'profile warning: using defaults\n{"entries":[{"num":1}],"metadata":null}';
  assert.deepEqual(parseCadenceStdout(stdout), {
    metadata: null,
    entries: [{ num: 1 }],
    cadenceConfig: null,
  });
});

test("缺 metadata / cadenceConfig：补 null，不 undefined", () => {
  assert.deepEqual(parseCadenceStdout('{"entries":[]}'), {
    metadata: null,
    entries: [],
    cadenceConfig: null,
  });
});

test("entries 不是数组（legacy 形状 / 坏了）：归一为空数组", () => {
  assert.deepEqual(parseCadenceStdout('{"entries":"nope","metadata":{}}'), {
    metadata: {},
    entries: [],
    cadenceConfig: null,
  });
});

// ---- 不可用（→ fail-closed） ----------------------------------------------

test("找不到 { 的纯文本输出 → null", () => {
  assert.equal(parseCadenceStdout("follow-up log empty; nothing to do"), null);
});

test("坏 JSON → null（半截输出不猜）", () => {
  assert.equal(parseCadenceStdout('{"entries":[{"num":1},'), null);
});

test("非字符串输入不崩溃：null / undefined / 数字 / 对象 → null", () => {
  assert.equal(parseCadenceStdout(null), null);
  assert.equal(parseCadenceStdout(undefined), null);
  assert.equal(parseCadenceStdout(42), null);
  assert.equal(parseCadenceStdout({}), null);
});
