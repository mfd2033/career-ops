// 收件箱 tab 点击不变量守卫（工单：点击收件箱 tab 无反应）。
//
// 为什么钉在源码上：TSX 不可在 node --test 里导入（web 组件无渲染测试基建，
// pipeline-single-nav-entry.test.mjs 同先例同口径），而这条约束恰好是纯声明式
// 的结构事实——收件箱按钮的 onClick 不得删除 tab 参数。
//
// 回归背景（0bac3f7）：管道页无 tab 参数时默认选中「全部」而非收件箱，但收件箱
// 按钮的 onClick 仍是 `setParams({ tab: null })`（删除参数）。删参数 → 无 tab →
// 回落默认 ALL → 点收件箱永远无反应。修复后收件箱必须显式写 tab=INBOX。
//
// Run:  node --test tests/lib/pipeline-inbox-tab.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = readFileSync(join(WEB, "src", "components", "pipeline-view.tsx"), "utf8");

/** 剥掉注释，只留代码——量结构不量散文（先例同口径，否则注释里的字面量能造成假红）。 */
function stripComments(src) {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = stripComments(SRC);

test("收件箱 tab 的 onClick 不得删除 tab 参数（删除=回落默认 ALL，点击无反应）", () => {
  //  buggy 形态：`tab: tabKey === "INBOX" ? null : tabKey`——INBOX 分支传 null，
  // 而 setParams 对 null 是 sp.delete("tab")。
  const deletePattern = /tab:\s*tabKey\s*===\s*"INBOX"\s*\?\s*null/;
  assert.ok(
    !deletePattern.test(CODE),
    '收件箱按钮仍在用 `tab: null`（删除参数）。无 tab 参数的默认是 ALL（0bac3f7 起），' +
      "点击收件箱会被立即回落——必须显式 setParams({ tab: tabKey })。",
  );
});

test("tab 按钮 onClick 对所有章节显式写 tab 参数", () => {
  // tabs.map 里唯一的 tab 切换调用点应统一为 `setParams({ tab: tabKey })`，
  // 不允许再出现任何按 tabKey 分支特判 null 的写法。
  const hits = CODE.match(/setParams\(\{\s*tab:[^}]*\}\)/g) ?? [];
  assert.ok(hits.length > 0, "tabs 按钮的 setParams({ tab: … }) 调用点未找到——组件结构变了，先更新本守卫");
  for (const h of hits) {
    assert.ok(!/null/.test(h), `tab 切换调用点出现 null（会删除参数并回落默认 tab）：${h}`);
  }
});
