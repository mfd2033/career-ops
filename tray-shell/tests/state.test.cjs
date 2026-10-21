"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TRAY_STATES, TOOLTIPS, trayStateOf, trayTooltip } = require("../src/state.cjs");

test("失败优先：即便还在重试，也先红着", () => {
  assert.equal(trayStateOf({ service: { failed: true, ready: true, starting: true } }), "failed");
});

test("就绪 → run", () => {
  assert.equal(trayStateOf({ service: { ready: true } }), "run");
});

test("起服中（有 spawn、端口还没应答）→ starting", () => {
  assert.equal(trayStateOf({ service: { starting: true, ready: false } }), "starting");
});

test("其余（从没起过 / 外部实例自己挂了）→ down", () => {
  assert.equal(trayStateOf({ service: {} }), "down");
  assert.equal(trayStateOf({}), "down");
  assert.equal(trayStateOf(null), "down");
});

test("状态集合与 tooltip 文案稳定", () => {
  assert.deepEqual(TRAY_STATES, ["run", "starting", "down", "failed"]);
  assert.equal(trayTooltip({ service: { ready: true } }, 3000), "career-ops · 服务正常 :3000");
  assert.equal(trayTooltip({ service: { starting: true } }), TOOLTIPS.starting);
  assert.equal(trayTooltip({ service: { failed: true } }), TOOLTIPS.failed);
  assert.equal(trayTooltip({ service: {} }), TOOLTIPS.down);
});
