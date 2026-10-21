"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseImageName, parseNetstatListening } = require("../src/proc.cjs");
const { ACTION_KILL_THEN_START, ACTION_REUSE, ACTION_START_FRESH, cannotFreeMsg, decideTakeover } = require("../src/service.cjs");

const NETSTAT = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1244
  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       8821
  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       9911
  TCP    192.168.1.7:3000       1.2.3.4:443            ESTABLISHED     8821
  TCP    [::]:3000              [::]:0                 LISTENING       7777
`;

test("netstat：按端口 + LISTENING 精确取 PID，不碰 3001 与 ESTABLISHED", () => {
  assert.equal(parseNetstatListening(NETSTAT, 3000), 8821);
  assert.equal(parseNetstatListening(NETSTAT, 3001), 9911);
  assert.equal(parseNetstatListening(NETSTAT, 4000), 0);
  assert.equal(parseNetstatListening("", 3000), 0);
});

test("tasklist 输出取镜像名", () => {
  assert.equal(parseImageName("node.exe                      8821 Console                    1     58,412 K"), "node.exe");
  assert.equal(parseImageName(""), "");
});

test("接管决策三分支（应答 → 复用，占位 → 杀，空闲 → 直起）", () => {
  // 应答的服务优先复用，哪怕它明显占着 socket
  assert.equal(decideTakeover(true, 8821), ACTION_REUSE);
  assert.equal(decideTakeover(false, 8821), ACTION_KILL_THEN_START);
  assert.equal(decideTakeover(false, 0), ACTION_START_FRESH);
});

test("释放失败提示点名占用者，且绝不建议换端口", () => {
  const message = cannotFreeMsg({ pid: 4242, image: "chrome.exe" }, "拒绝访问");
  assert.match(message, /chrome\.exe \(PID 4242\)/);
  assert.match(message, /拒绝访问/);
  assert.match(message, /端口固定为 3000/);
  assert.doesNotMatch(message, /改用 ?30\d\d/);
});
