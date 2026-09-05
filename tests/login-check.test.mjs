// judgeLogin 纯函数单测 — multi-signal 登录判定（lib/login-check.mjs）。
//
// 判定是 zh-collect.mjs / zh-login-check.mjs 登录预检的核心，单信号可弱可误报，
// 只有组合才下结论。本测试锁定规则表（顺序即优先级）：
//   1. jobData === false → not-logged-in（登录墙/验证墙统一兜底）
//   2. loginButton === true → not-logged-in（登录按钮还挂着）
//   3. sessionCookies && userArea → logged-in（双正信号）
//   4. 双负（都明确 false）→ not-logged-in
//   5. 其余 → uncertain（不猜）
//
// Run:  node --test tests/login-check.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeLogin, LOGIN_VERDICT } from "../lib/login-check.mjs";

// ── 规则 1：拿不到职位数据 = 未登录（最高优先级，不采样则跳过） ──

test("jobData=false wins even when everything else says logged-in", () => {
  assert.equal(judgeLogin("zhipin", { jobData: false, sessionCookies: true, userArea: true, loginButton: false }), LOGIN_VERDICT.NOT_LOGGED_IN);
});

test("jobData=false wins over a visible login button state", () => {
  assert.equal(judgeLogin("liepin", { jobData: false, loginButton: false, userArea: false }), LOGIN_VERDICT.NOT_LOGGED_IN);
});

// ── 规则 2：登录按钮可见 = 未登录 ──

test("loginButton=true is not-logged-in", () => {
  assert.equal(judgeLogin("zhipin", { loginButton: true }), LOGIN_VERDICT.NOT_LOGGED_IN);
});

test("loginButton=true beats a matching cookie hint", () => {
  // 猎聘 acw_tc 未登录也可能带——登录按钮还在，就不许判 logged-in。
  assert.equal(judgeLogin("liepin", { loginButton: true, sessionCookies: true }), LOGIN_VERDICT.NOT_LOGGED_IN);
});

// ── 规则 3：双正信号才确认登录 ──

test("sessionCookies+userArea is logged-in (jobData unsampled)", () => {
  assert.equal(judgeLogin("zhipin", { sessionCookies: true, userArea: true }), LOGIN_VERDICT.LOGGED_IN);
});

test("sessionCookies+userArea+jobData is logged-in", () => {
  assert.equal(judgeLogin("zhaopin", { sessionCookies: true, userArea: true, jobData: true, loginButton: false }), LOGIN_VERDICT.LOGGED_IN);
});

// ── 规则 4：双负 → 未登录 ──

test("both signals clearly false is not-logged-in", () => {
  assert.equal(judgeLogin("zhipin", { sessionCookies: false, userArea: false }), LOGIN_VERDICT.NOT_LOGGED_IN);
});

// ── 规则 5：单正/缺失信号 → uncertain（不猜） ──

test("only a cookie hit is uncertain (cookie can pre-exist logged-out)", () => {
  assert.equal(judgeLogin("liepin", { sessionCookies: true }), LOGIN_VERDICT.UNCERTAIN);
});

test("only a user area is uncertain", () => {
  assert.equal(judgeLogin("zhipin", { userArea: true }), LOGIN_VERDICT.UNCERTAIN);
});

test("all signals unsampled is uncertain", () => {
  assert.equal(judgeLogin("zhipin", {}), LOGIN_VERDICT.UNCERTAIN);
  assert.equal(judgeLogin("liepin"), LOGIN_VERDICT.UNCERTAIN);
});

test("conflicting single signals stay uncertain", () => {
  assert.equal(judgeLogin("zhaopin", { sessionCookies: true, userArea: false }), LOGIN_VERDICT.UNCERTAIN);
  assert.equal(judgeLogin("zhaopin", { sessionCookies: false, userArea: true }), LOGIN_VERDICT.UNCERTAIN);
});

// ── 平台不敏感：judgeLogin 不依赖平台特定名单（cookie 前缀名单在采集侧） ──

test("verdicts are platform-agnostic at the pure-function layer", () => {
  const cases = [
    ["zhipin", { sessionCookies: true, userArea: true }, LOGIN_VERDICT.LOGGED_IN],
    ["liepin", { sessionCookies: true, userArea: true }, LOGIN_VERDICT.LOGGED_IN],
    ["zhaopin", { sessionCookies: true, userArea: true }, LOGIN_VERDICT.LOGGED_IN],
    ["zhipin", { loginButton: true }, LOGIN_VERDICT.NOT_LOGGED_IN],
    ["liepin", { loginButton: true }, LOGIN_VERDICT.NOT_LOGGED_IN],
    ["zhaopin", { loginButton: true }, LOGIN_VERDICT.NOT_LOGGED_IN],
  ];
  for (const [p, s, want] of cases) assert.equal(judgeLogin(p, s), want, `${p} ${JSON.stringify(s)}`);
});

// ── 非法输入：不明平台不抛错。全局强信号（jobData/loginButton）照常生效，
// 只有依赖平台 cookie 名单的组合规则（双正/双负）在未知平台上不猜 → uncertain ──

test("unknown platform applies global signals, stays uncertain on cookie combos", () => {
  assert.equal(judgeLogin("someboard", { loginButton: true }), LOGIN_VERDICT.NOT_LOGGED_IN);
  assert.equal(judgeLogin("someboard", { jobData: false }), LOGIN_VERDICT.NOT_LOGGED_IN);
  assert.equal(judgeLogin("someboard", { sessionCookies: true, userArea: true }), LOGIN_VERDICT.UNCERTAIN);
  assert.equal(judgeLogin("someboard", {}), LOGIN_VERDICT.UNCERTAIN);
});
