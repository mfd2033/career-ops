import test from "node:test";
import assert from "node:assert/strict";
import { parseBskStatus, isBskBoardUrl, bskUnavailableBody, BSK_UNAVAILABLE_CODE } from "../../src/lib/bsk-daemon.mjs";

// #1360 的教训：通道不可用必须在派发前被认出来，而不是让 worker 交一份
// 「全维未获取到」的报告。下面三种状态分别对应三种处置，不能互相折叠。
test("守护进程在且浏览器已连接 → ok", () => {
  const state = parseBskStatus({
    code: 0,
    stdout: JSON.stringify({
      browsers: [{ browser_name: "edge", unresponsive: false, session_count: 0 }],
      compatibility: {},
    }),
  });
  assert.deepEqual(state, { ok: true, daemon: true, browsers: 1, reason: "" });
});

test("守护进程在但没有浏览器扩展 → daemon 为真、ok 为假（不能当成『没启动』）", () => {
  const state = parseBskStatus({ code: 0, stdout: JSON.stringify({ browsers: [] }) });
  assert.equal(state.ok, false);
  assert.equal(state.daemon, true);
  assert.match(state.reason, /no browser extension/);
});

test("死掉的浏览器连接不算可用", () => {
  const state = parseBskStatus({
    code: 0,
    stdout: JSON.stringify({ browsers: [{ unresponsive: true }] }),
  });
  assert.equal(state.ok, false);
  assert.equal(state.browsers, 0);
});

test("带 BOM 的 JSON 仍然可解析（bsk 的输出会带 BOM）", () => {
  const state = parseBskStatus({
    code: 0,
    stdout: `\uFEFF${JSON.stringify({ browsers: [{ unresponsive: false }] })}`,
  });
  assert.equal(state.ok, true);
});

test("守护进程不在：命令失败 → 取 stderr 首行作为原因，截断到 200 字", () => {
  const long = "cannot start an independent Windows daemon".repeat(20);
  const state = parseBskStatus({ code: 1, stdout: "", stderr: `${long}\nsecond line` });
  assert.equal(state.ok, false);
  assert.equal(state.daemon, false);
  assert.equal(state.reason.length, 200);
});

test("bsk 把失败原因写成 stdout JSON（exit 2）时取 message，而不是取到一截 '{'", () => {
  const state = parseBskStatus({
    code: 2,
    stdout: JSON.stringify({
      code: null,
      message: "ensure daemon is running: the Job Object of this process does not allow breakaway",
      hint: "start it from an independent terminal",
      exit_code: 2,
    }),
  });
  assert.equal(state.ok, false);
  assert.equal(state.daemon, false);
  assert.match(state.reason, /does not allow breakaway/);
  assert.equal(state.reason.startsWith("{"), false);
});

test("非 JSON 的成功输出不算可用（不把半截/空输出当成就绪）", () => {
  const state = parseBskStatus({ code: 0, stdout: "" });
  assert.equal(state.ok, false);
  assert.match(state.reason, /no output/);
});

test("超时被杀 → 原因明确写成 timed out，不误报成退出码", () => {
  const state = parseBskStatus({ code: null, killed: true, stdout: "", stderr: "" });
  assert.equal(state.daemon, false);
  assert.equal(state.reason, "bsk status timed out");
});

// web 端这份域名集合必须与 lib/zh-jobs.mjs 完全一致，否则会出现
// 「代码说不需要 bsk、worker 却走进验证墙」。
test("国内招聘站判定：四个域及其子域命中，反例不误伤", () => {
  for (const url of [
    "https://www.zhipin.com/job_detail/abc.html",
    "https://kanzhun.com/job/1",
    "https://m.liepin.com/job/1986662929.shtml",
    "https://jobs.zhaopin.com/CC1.htm",
    "https://WWW.ZHAOPIN.COM/jobdetail/x.htm",
  ]) {
    assert.equal(isBskBoardUrl(url), true, url);
  }
  for (const url of ["https://notzhipin.com/job/1", "https://example.com/zhipin.com", "not a url", ""]) {
    assert.equal(isBskBoardUrl(url), false, url);
  }
});

test("派发前拦截体：守护进程不在与浏览器没连给不同的 readable error，同一个 error code", () => {
  const down = bskUnavailableBody({ daemon: false, browsers: 0, reason: "connection refused" });
  const noBrowser = bskUnavailableBody({ daemon: true, browsers: 0, reason: "no browser extension is connected" });
  assert.equal(down.code, BSK_UNAVAILABLE_CODE);
  assert.equal(noBrowser.code, BSK_UNAVAILABLE_CODE);
  assert.match(down.error, /not running/);
  assert.match(noBrowser.error, /no browser extension/);
  assert.equal(down.detail, "connection refused");
});