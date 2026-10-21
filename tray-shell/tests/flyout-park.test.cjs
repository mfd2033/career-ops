"use strict";

// 回归守卫（2026-10-21，面板弹出「先闪一下」）：
//
// 症状：点托盘后面板先半透明/露出底下窗口，约 200ms 后才实心 —— 实测是窗口层的
// alpha 淡入，只在走 ShowWindow（hide → show）时出现：hide() 之后 Chromium 挂起，
// 下次 show 要等一帧窗口级淡入（等步长、183–222ms）。改成「窗口只 show 一次，
// 之后只切 alpha」就没了（点击→画上：343ms → 196ms，pixel probe 实测）。
//
// 这条守卫钉住实现方式，因为真正的证据（像素时间线）只能靠 .scratch 里的探针脚本
// 取，单测拿不到屏幕：谁把 parkFlyout 改回 hide()、或忘了鼠标穿透，这里就红。
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");

/** 剥掉行注释与块注释，避免注释里提到的 hide() 把守卫骗红/骗绿。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CODE = stripComments(SRC);

function bodyOf(name) {
  const start = CODE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `找不到 ${name}()`);
  let depth = 0;
  let i = CODE.indexOf("{", start);
  const from = i;
  for (; i < CODE.length; i += 1) {
    if (CODE[i] === "{") depth += 1;
    else if (CODE[i] === "}") {
      depth -= 1;
      if (depth === 0) return CODE.slice(from, i + 1);
    }
  }
  throw new Error(`${name}() 的括号没闭合`);
}

test("面板收起不得用 hide()：show/hide 会引入窗口层 alpha 淡入（弹出时闪一下）", () => {
  assert.equal(/flyout\.hide\(\)/.test(CODE), false, "main.cjs 里又出现了 flyout.hide()");
  assert.equal(/\.hide\(\)/.test(bodyOf("toggleFlyout")), false, "toggleFlyout 里出现了 hide()");
  assert.equal(/\.hide\(\)/.test(bodyOf("parkFlyout")), false, "parkFlyout 里出现了 hide()");
});

test("parkFlyout：收 alpha + 鼠标穿透 + 取消置顶，三件缺一不可", () => {
  const body = bodyOf("parkFlyout");
  assert.match(body, /setOpacity\(0\)/, "收起要先把 alpha 收到 0");
  assert.match(body, /setIgnoreMouseEvents\(true\)/, "alpha 0 的分层窗口仍会吃掉点击，必须穿透");
  assert.match(body, /setAlwaysOnTop\(false\)/, "隐形又置顶会干扰别的窗口的遮挡判定");
  assert.match(body, /flyoutParked\s*=\s*true/, "收起状态要记在 flyoutParked 上");
});

test("打开面板：恢复鼠标事件、恢复置顶、再抬 alpha（顺序不能反）", () => {
  const body = bodyOf("toggleFlyout");
  const ignore = body.indexOf("setIgnoreMouseEvents(false)");
  const top = body.indexOf("setAlwaysOnTop(true)");
  const opacity = body.indexOf("setOpacity(1)");
  assert.ok(ignore > -1, "打开时要恢复鼠标事件");
  assert.ok(top > -1, "打开时要恢复置顶");
  assert.ok(opacity > -1, "打开时要把 alpha 抬回 1");
  assert.ok(ignore < opacity && top < opacity, "先恢复交互能力，再露出来");
  assert.match(body, /flyoutParked\s*=\s*false/, "打开状态要记在 flyoutParked 上");
});

test("窗口只在创建时 show 一次（alpha 0 + 穿透），之后就靠 alpha 切显隐", () => {
  const body = bodyOf("createFlyout");
  assert.match(body, /setOpacity\(0\)/, "创建时要先置 alpha 0");
  assert.match(body, /setIgnoreMouseEvents\(true\)/, "创建时就要穿透，否则隐形窗口会挡点击");
  assert.match(body, /showInactive\(\)/, "创建时只 show 这一次，且不抢焦点");
  assert.match(body, /parkFlyout\(\)/, "blur/close 应走 parkFlyout 而不是 hide");
});

test("blur 自动收起仍有 developer-tools 豁免（验收时要能开着面板查 DOM）", () => {
  assert.match(CODE, /isDevToolsOpened\(\)/, "blur 收起要保留 DevTools 豁免");
});
