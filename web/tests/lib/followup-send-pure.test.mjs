// followup-send-pure 纯逻辑单测：三站识别、话术压行、输入框/发送按钮候选打分、
// 发送结果核对、联系人挑选、备注模板。
//
// 这些判断决定「自动跟进」会不会点错按钮、会不会把没发出去的消息报成成功，
// 所以逐条钉住：显隐/只读/搜索框必须被挡、投递类按钮必须被挡、两项回读缺一不可。
//
// Run:  node --test web/tests/lib/followup-send-pure.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "followup-send-pure.js")).href);
const {
  SITES,
  siteForUrl,
  joinMessage,
  placeholderTokens,
  fingerprint,
  scoreInputCandidate,
  scoreSendCandidate,
  pickInputCandidate,
  pickSendCandidate,
  pickContactCandidate,
  verifySend,
  autoNotes,
} = mod.default ?? mod;

/** 一个「长得像聊天框」的基准描述，各用例按需覆盖字段。 */
const chatBox = (over = {}) => ({
  tag: "textarea",
  type: "",
  contentEditable: false,
  visible: true,
  width: 320,
  height: 60,
  bottomGap: 60,
  placeholder: "输入消息…",
  classText: "chat-input",
  idText: "",
  ariaLabel: "",
  readOnly: false,
  disabled: false,
  ...over,
});

// ---- 站点识别 --------------------------------------------------------------

test("三站表只认这三家，子域也算", () => {
  assert.deepEqual(
    SITES.map((s) => s.host),
    ["zhipin.com", "liepin.com", "zhaopin.com"],
  );
  assert.equal(siteForUrl("https://www.zhipin.com/job_detail/abc.html").id, "boss");
  assert.equal(siteForUrl("https://m.zhipin.com/wapi/x").id, "boss");
  assert.equal(siteForUrl("https://www.liepin.com/job/123.shtml").id, "liepin");
  assert.equal(siteForUrl("https://c.liepin.com/im/chat").id, "liepin");
  assert.equal(siteForUrl("https://jobs.zhaopin.com/CC123.htm").id, "zhaopin");
});

test("企业官网与非法输入一律返回 null（回落复制+打开）", () => {
  assert.equal(siteForUrl("https://careers.tencent.com/job/1"), null);
  assert.equal(siteForUrl("https://www.meituan.com/jobs/2"), null);
  assert.equal(siteForUrl("javascript:alert(1)"), null);
  assert.equal(siteForUrl("not a url"), null);
  assert.equal(siteForUrl(""), null);
  assert.equal(siteForUrl(null), null);
  // 后缀匹配不能把 zhipin.com.evil.cn 当成 BOSS
  assert.equal(siteForUrl("https://www.zhipin.com.evil.cn/job/1"), null);
});

// ---- 文本规整 --------------------------------------------------------------

test("多行话术压成一行：空行丢掉、空白压缩，字一个不丢", () => {
  const raw = "您好，我是候选人\r\n\r\n我有 16 年经验   PMP\n\n这个岗位还在招人吗？";
  assert.equal(joinMessage(raw), "您好，我是候选人 我有 16 年经验 PMP 这个岗位还在招人吗？");
});

test("joinMessage 对单行文本是恒等（除首尾空白）", () => {
  assert.equal(joinMessage("  你好  "), "你好");
  assert.equal(joinMessage(null), "");
});

test("占位符枚举：去重、保序", () => {
  assert.deepEqual(placeholderTokens("你好{城市}，{城市}这个岗位{时间}还在招吗"), ["{城市}", "{时间}"]);
  assert.deepEqual(placeholderTokens("没有占位符"), []);
});

test("指纹取末 12 个非空白字符；太短返回空串", () => {
  assert.equal(fingerprint("这个岗位还在招人吗？"), "这个岗位还在招人吗？");
  assert.equal(fingerprint("一二三四五"), "一二三四五");
  assert.equal(fingerprint("短"), "");
});

// ---- 输入框打分 ------------------------------------------------------------

test("贴底的多行聊天框能过阈值", () => {
  assert.ok(scoreInputCandidate(chatBox()) >= 5);
});

test("隐藏 / 只读 / 禁用的输入框直接判死", () => {
  assert.equal(scoreInputCandidate(chatBox({ visible: false })), -1);
  assert.equal(scoreInputCandidate(chatBox({ readOnly: true })), -1);
  assert.equal(scoreInputCandidate(chatBox({ disabled: true })), -1);
  assert.equal(scoreInputCandidate(chatBox({ height: 4 })), -1);
  assert.equal(scoreInputCandidate(null), -1);
});

test("页面搜索框不当聊天框", () => {
  const search = chatBox({ tag: "input", type: "text", placeholder: "搜索职位", classText: "search-input", bottomGap: 120 });
  assert.ok(scoreInputCandidate(search) < 5, `搜索框不该过阈值，实得 ${scoreInputCandidate(search)}`);
  // 单行输入框只靠位置与尺寸，不给高分
  const bare = chatBox({ tag: "input", type: "text", placeholder: "", classText: "", bottomGap: 60 });
  assert.ok(scoreInputCandidate(bare) < 5);
});

test("pickInputCandidate 取分最高的那个，全不达标返回 null", () => {
  const list = [
    chatBox({ visible: false }),
    chatBox({ tag: "input", type: "text", placeholder: "搜索", classText: "search", bottomGap: 40 }),
    chatBox({ bottomGap: 40 }),
  ];
  const best = pickInputCandidate(list);
  assert.equal(best.index, 2);
  assert.equal(pickInputCandidate([chatBox({ visible: false })]), null);
});

// ---- 发送按钮打分 ----------------------------------------------------------

test("「发送」按钮得分够、可被选中", () => {
  const btn = { text: "发送", tag: "button", visible: true, disabled: false, width: 60, height: 28, classText: "send-btn" };
  assert.ok(scoreSendCandidate(btn) >= 3);
});

test("投递 / 简历 / 申请类按钮一律不可选（绝不误触代投）", () => {
  for (const text of ["发送简历", "立即投递", "申请职位", "APPLY"]) {
    assert.equal(
      scoreSendCandidate({ text, tag: "button", visible: true, disabled: false, width: 80, height: 28, classText: "send-btn" }),
      -1,
      `${text} 不该被当成发送按钮`,
    );
  }
});

test("隐藏/禁用/过小的按钮不选；全部不达标返回 null", () => {
  assert.equal(scoreSendCandidate({ text: "发送", tag: "button", visible: false, width: 60, height: 28 }), -1);
  assert.equal(scoreSendCandidate({ text: "发送", tag: "button", visible: true, disabled: true, width: 60, height: 28 }), -1);
  assert.equal(scoreSendCandidate({ text: "发送", tag: "button", visible: true, width: 6, height: 28 }), -1);
  assert.equal(pickSendCandidate([{ text: "取消", tag: "button", visible: true, width: 60, height: 28 }]), null);
});

// ---- 回读校验 --------------------------------------------------------------

test("输入框清空 + 聊天流出现该句 = 已发送", () => {
  const text = "您好，我是候选人，这个岗位还在招人吗？";
  const v = verifySend({ after: "", messages: ["在的，方便聊聊吗", text], expectText: text });
  assert.deepEqual(v, { ok: true, cleared: true, echoed: true });
});

test("两项缺一不可：只清空 / 只回显都算不确定", () => {
  const text = "您好，我是候选人，这个岗位还在招人吗？";
  const onlyCleared = verifySend({ after: "", messages: ["在的"], expectText: text });
  assert.equal(onlyCleared.ok, false);
  assert.equal(onlyCleared.cleared, true);
  assert.equal(onlyCleared.echoed, false);

  const onlyEcho = verifySend({ after: text, messages: [text], expectText: text });
  assert.equal(onlyEcho.ok, false);
  assert.equal(onlyEcho.cleared, false);
  assert.equal(onlyEcho.echoed, true);
});

test("核对文案里的换行不影响命中", () => {
  const text = "您好\n这个岗位还在招人吗？";
  const v = verifySend({ after: "", messages: ["您好 这个岗位还在招人吗？"], expectText: text });
  assert.equal(v.ok, true);
});

// ---- 联系人 ----------------------------------------------------------------

test("联系人取聊天头部名字，页面噪音不算", () => {
  const picked = pickContactCandidate([
    { text: "搜索", classText: "search-name", top: 10, visible: true },
    { text: "张三 · 招聘负责人", classText: "chat-title-name", top: 120, visible: true },
    { text: "这条消息预览预览预览预览", classText: "msg-name", top: 300, visible: true },
  ]);
  assert.equal(picked, "张三 · 招聘负责人");
});

test("没有像样的候选就返回 null，不编人名", () => {
  assert.equal(pickContactCandidate([]), null);
  assert.equal(pickContactCandidate([{ text: "搜", classText: "x-name", top: 0, visible: true }]), null);
  assert.equal(pickContactCandidate([{ text: "张三", classText: "x-name", top: 0, visible: false }]), null);
});

// ---- 备注模板 --------------------------------------------------------------

test("备注模板带站点名，缺站点时落「招聘平台」", () => {
  assert.equal(autoNotes("BOSS直聘"), "BOSS直聘站内信发送跟进话术");
  assert.equal(autoNotes(""), "招聘平台站内信发送跟进话术");
});
