// 自动跟进（跟进页 ⚡）源码守卫：入口存在、发送必经确认按钮、记录字段齐全、
// 三站表两侧不漂移、i18n 成对、扩展清单已挂上新脚本。
//
// 量结构不量散文：先剥注释再计数（同 followup-log-entry.test.mjs 的口径）。
//
// Run:  node --test web/tests/lib/auto-followup.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

const readWeb = (rel) => readFileSync(join(HERE, "..", "..", "src", rel), "utf8");
const readRepo = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** 剥掉块注释与行内注释，守卫量结构不量散文。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
}

const VIEW = stripComments(readWeb("components/followups/followups-view.tsx"));
const DIALOG = stripComments(readWeb("components/followups/auto-followup-dialog.tsx"));
const DICT = readWeb("lib/i18n/clusters/followups.ts");
const EXT_JS = stripComments(readRepo("extension/followup-send.js"));
const BG = stripComments(readRepo("extension/background.js"));
const MANIFEST = JSON.parse(readRepo("extension/manifest.json"));

const count = (haystack, needle) => haystack.split(needle).length - 1;

// ---- 入口 ------------------------------------------------------------------

test("行操作区首位有 ⚡ 入口，并接到弹窗状态", () => {
  assert.ok(VIEW.includes("<Zap className=\"size-3.5\" />"), "行操作区必须有 Zap（⚡）图标按钮");
  assert.ok(
    VIEW.includes("onAuto={() => setAutoFor(e)}"),
    "每行必须把 onAuto 接回 setAutoFor（行内入口 → 弹窗）",
  );
  assert.ok(
    VIEW.includes("<AutoFollowupDialog entry={autoFor}"),
    "视图必须在 autoFor 存在时渲染 AutoFollowupDialog",
  );
});

test("⚡ 排在记录按钮之前（主操作唯一，其余降级）", () => {
  const autoAt = VIEW.indexOf("onClick={onAuto}");
  const logAt = VIEW.indexOf("onClick={onLog}");
  assert.ok(autoAt > 0 && logAt > 0, "两个 onClick 都要在行操作区里");
  assert.ok(autoAt < logAt, "自动跟进是主操作，必须排在「记录」之前");
});

// ---- 发送必须经过确认 ------------------------------------------------------

test("startSend 只由确认阶段的按钮触发一次（点下即发，不重试不批量）", () => {
  assert.equal(count(DIALOG, "startSend"), 2, "startSend 应只有「定义 + 一次 onClick」两处");
  assert.equal(count(DIALOG, "onClick={startSend}"), 1, "确认按钮必须唯一");
  const confirmPhase = DIALOG.indexOf('{phase === "confirm" ? (');
  const loggingPhase = DIALOG.indexOf("<OutcomeBanner");
  const sendAt = DIALOG.indexOf("onClick={startSend}");
  assert.ok(confirmPhase > 0 && loggingPhase > confirmPhase, "两阶段分支要按顺序出现");
  assert.ok(sendAt > confirmPhase && sendAt < loggingPhase, "发送按钮必须落在「确认话术」阶段里");
});

test("发送走扩展桥的 followup-send 消息，不是页面内自造请求", () => {
  assert.ok(DIALOG.includes('extRequest({ type: "followup-send"'), "必须经 extRequest 发 followup-send");
  assert.ok(DIALOG.includes("SEND_TIMEOUT_MS"), "必须有显式超时，避免弹窗永久挂住");
});

test("发送前先把话术写进剪贴板（扩展缺席时的兜底）", () => {
  const sendAt = DIALOG.indexOf("const startSend");
  const copyAt = DIALOG.indexOf("await copyToClipboard(message)", sendAt);
  const requestAt = DIALOG.indexOf("await extRequest(", sendAt);
  assert.ok(copyAt > sendAt && requestAt > copyAt, "顺序必须是：先落剪贴板，再请扩展发送");
});

// ---- 记录字段齐全 ----------------------------------------------------------

test("记录走 POST /api/followups/log，八个字段一个不少", () => {
  assert.ok(DIALOG.includes('fetch("/api/followups/log"'), "必须写 /api/followups/log");
  for (const field of [
    "appNum: entry.num",
    "company: entry.company",
    "role: entry.role",
    "date,",
    "channel,",
    "contact: tableSafe(contact)",
    "notes: tableSafe(notes)",
    "unread,",
  ]) {
    assert.ok(DIALOG.includes(field), `记录请求缺字段：${field}`);
  }
});

test("只有「已发送」才自动勾对方未读；不确定时不勾", () => {
  const sentBlock = DIALOG.slice(DIALOG.indexOf("if (sent) {"), DIALOG.indexOf("} else if (kind === \"uncertain\")"));
  assert.ok(sentBlock.includes("setUnread(true)"), "已发送才勾未读");
  const uncertainBlock = DIALOG.slice(DIALOG.indexOf("} else if (kind === \"uncertain\")"), DIALOG.indexOf("} catch {"));
  assert.ok(!uncertainBlock.includes("setUnread(true)"), "不确定时绝不能自动勾未读");
});

// ---- 三站表两侧不漂移 ------------------------------------------------------

const extPure = (await import(pathToFileURL(join(ROOT, "extension", "followup-send-pure.js")).href)).default;
const webPure = await import(pathToFileURL(join(HERE, "..", "..", "src", "lib", "followup-auto.mjs")).href);

test("扩展与 web 的三站表逐字一致", () => {
  assert.deepEqual(
    extPure.SITES.map(({ id, label, host }) => ({ id, label, host })),
    webPure.AUTO_SEND_SITES.map(({ id, label, host }) => ({ id, label, host })),
  );
});

test("压行规则两侧同结果（确认的文本 = 发出的文本）", () => {
  const samples = [
    "您好\n\n我有 16 年经验   PMP\n这个岗位还在招人吗？",
    "  单行  ",
    "第一行\r\n第二行",
    "",
  ];
  for (const sample of samples) {
    assert.equal(webPure.toSingleLine(sample), extPure.joinMessage(sample), `压行结果不一致：${JSON.stringify(sample)}`);
  }
});

test("备注模板两侧同一句", () => {
  for (const label of ["BOSS直聘", "猎聘", "智联招聘", ""]) {
    assert.equal(webPure.autoNotes(label), extPure.autoNotes(label));
  }
});

test("web 侧站点识别与扩展侧同判定", () => {
  for (const url of ["https://www.zhipin.com/x", "https://www.liepin.com/y", "https://jobs.zhaopin.com/z", "https://careers.tencent.com/a", "bad"]) {
    assert.equal(
      webPure.autoSiteForUrl(url)?.id ?? null,
      extPure.siteForUrl(url)?.id ?? null,
      `两侧对 ${url} 判定不一致`,
    );
  }
});

// ---- i18n ----------------------------------------------------------------

test("followups.auto* 键 en/zh 成对且集合相同", () => {
  const keysOf = (segment) => {
    const from = DICT.indexOf(segment === "en" ? "export const en" : "export const zh");
    const to = DICT.indexOf("};", from);
    const body = DICT.slice(from, to);
    return [...body.matchAll(/"(followups\.auto[^"]*)":/g)].map((m) => m[1]).sort();
  };
  const en = keysOf("en");
  const zh = keysOf("zh");
  assert.ok(en.length >= 25, `自动跟进的界面键太少（${en.length}），确认没漏文案`);
  assert.deepEqual(zh, en);
});

// ---- 扩展侧 --------------------------------------------------------------

test("manifest 挂上了发送脚本，版本已升到 0.2.0", () => {
  assert.equal(MANIFEST.version, "0.2.0");
  const siteBlocks = MANIFEST.content_scripts.filter((block) => block.matches.some((m) => /zhipin|liepin|zhaopin/.test(m)));
  assert.equal(siteBlocks.length, 3, "三站各一段 content_scripts");
  for (const block of siteBlocks) {
    assert.ok(block.js.includes("followup-send-pure.js"), `${block.matches[0]} 缺纯逻辑模块`);
    assert.ok(block.js.includes("followup-send.js"), `${block.matches[0]} 缺发送脚本`);
    const pure = block.js.indexOf("followup-send-pure.js");
    const send = block.js.indexOf("followup-send.js");
    assert.ok(pure < send, `${block.matches[0]} 的纯逻辑必须排在发送脚本之前`);
  }
});

test("SW 有 followup-send 分支，且转发给内容脚本", () => {
  assert.ok(BG.includes('case "followup-send"'), "background.js 缺 followup-send 分支");
  assert.ok(
    BG.includes('chrome.tabs.sendMessage(tab.id, { type: "followup-send"'),
    "SW 必须把消息转发给内容脚本",
  );
  assert.ok(BG.includes("sendFollowup(msg)"), "分支必须调用 sendFollowup");
});

test("内容脚本只在三站生效，且发送后做两项回读", () => {
  assert.ok(EXT_JS.includes('msg.type !== "followup-send"'), "内容脚本必须只应答 followup-send");
  assert.ok(EXT_JS.includes("P.verifySend("), "必须调用纯逻辑层的回读校验");
  assert.ok(EXT_JS.includes("waitCleared("), "必须等输入框清空");
  assert.ok(EXT_JS.includes("readMessages("), "必须读聊天流做回显比对");
  // 一次点击只发一条：发送动作在脚本里只有一处调用点
  assert.equal(count(EXT_JS, "button.click()"), 1, "发送点击只能有一处");
});
