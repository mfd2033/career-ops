// followup-channel 纯逻辑单测：跟进渠道白名单归一化 + 显示词典查表。
// 背景：web 端「记录跟进」新增 Platform（招聘平台）渠道；渠道值的合法集
// 只有一个事实来源（本模块），显示翻译走 i18n 键表，未知值原样显示以
// 兼容旧 bullet 数据（无 channel）。
//
// Run:  node --test web/tests/lib/followup-channel.test.mjs
//
// 放在 web/tests/lib 同族纯逻辑测试之间，由 test-all.mjs 的 web/tests/lib
// 批次自动一并门住（目录级 glob，无需登记）。

import test from "node:test";
import assert from "node:assert/strict";
import { CHANNELS, DEFAULT_CHANNEL, normalizeChannel, channelLabelKey } from "../../src/lib/followup-channel.mjs";

// ---- DEFAULT_CHANNEL：表单预选渠道 ----------------------------------------

test("默认渠道是 Platform（用户决策 2026-09-28）", () => {
  assert.equal(DEFAULT_CHANNEL, "Platform");
});

test("默认渠道必须是合法枚举值——防止改名后默认为非法值", () => {
  assert.ok(CHANNELS.includes(DEFAULT_CHANNEL), `${DEFAULT_CHANNEL} 不在 CHANNELS 里`);
});

// ---- CHANNELS：枚举顺序即下拉框顺序 --------------------------------------

test("CHANNELS 按既定顺序包含 Platform（Email、LinkedIn、Platform、Phone、Other）", () => {
  assert.deepEqual([...CHANNELS], ["Email", "LinkedIn", "Platform", "Phone", "Other"]);
});

// ---- normalizeChannel：后端落盘前的白名单归一化 ----------------------------

test("四个既有英文值精确匹配通过（既有行为不回归）", () => {
  for (const c of ["Email", "LinkedIn", "Phone", "Other"]) {
    assert.equal(normalizeChannel(c), c);
  }
});

test("新值 Platform 通过校验并原样归一化", () => {
  assert.equal(normalizeChannel("Platform"), "Platform");
});

test("大小写不敏感：platform / PLATFORM 归一化为规范值", () => {
  assert.equal(normalizeChannel("platform"), "Platform");
  assert.equal(normalizeChannel("PLATFORM"), "Platform");
});

test("首尾空白被容忍", () => {
  assert.equal(normalizeChannel("  Email  "), "Email");
});

test("未知值拒绝：返回 null，交由路由 400", () => {
  assert.equal(normalizeChannel("WeChat"), null);
  assert.equal(normalizeChannel(""), null);
  assert.equal(normalizeChannel("   "), null);
});

test("中文值不容错：招聘平台不是合法输入（用户决策 Q8）", () => {
  assert.equal(normalizeChannel("招聘平台"), null);
});

test("非字符串输入不崩溃", () => {
  assert.equal(normalizeChannel(undefined), null);
  assert.equal(normalizeChannel(null), null);
  assert.equal(normalizeChannel(42), null);
});

// ---- channelLabelKey：显示层 i18n 查表 -------------------------------------

test("五个已知渠道各有对应的 i18n 键", () => {
  for (const c of CHANNELS) {
    assert.equal(channelLabelKey(c), `followups.channel.${c}`);
  }
});

test("大小写不同的已知值也能命中键（数据层历史脏值兼容）", () => {
  assert.equal(channelLabelKey("email"), "followups.channel.Email");
});

test("未知值返回 null → 调用方原样显示，不显示键名", () => {
  assert.equal(channelLabelKey("Fax"), null);
  assert.equal(channelLabelKey(""), null);
});
