// 管道页批量条「常显」不变量守卫（用户要求 2026-10-28，ADR-0039 修订）。
//
// 为什么钉在源码上：TSX 不可在 node --test 里导入（web 组件无渲染测试基建，
// pipeline-inbox-tab.test.mjs / pipeline-single-nav-entry.test.mjs 同先例同口径），
// 而这条约束是纯声明式的结构事实——条体不得再被勾选集条件包住、四个动作按钮不得
// 再在零勾选时可点。
//
// 回归背景：ADR-0039 决议 4 原本是「槽位恒在、内容切空态提示语」，条体只在
// `selected.size > 0` 时渲染，用户对着的是一段没有信息的空白；本次改成整条常显
// （与收件箱批量条同口径），未勾选是常态而不是空态。
//
// Run:  node --test web/tests/lib/pipeline-batch-bar-always-visible.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VIEW = readFileSync(join(WEB, "src", "components", "pipeline-view.tsx"), "utf8");
const DICT = readFileSync(join(WEB, "src", "lib", "i18n", "clusters", "pipeline.ts"), "utf8");

/** 剥掉注释，只留代码——量结构不量散文（同先例口径，否则注释里的字面量会造成假红）。 */
function stripComments(src) {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = stripComments(VIEW);

test("批量条条体常显：不再被勾选集条件渲染，槽位 hint 退役为空串", () => {
  assert.match(CODE, /<RowSlot hint="">/, "管道批量条应显式传空 hint——提示语回退分支已退役");
  // 旧形态：`{selected.size > 0 && (<div className="flex flex-wrap …` 包住整条条体。
  assert.doesNotMatch(
    CODE,
    /selected\.size > 0 &&\s*\(?\s*<div className="flex flex-wrap/,
    "条体不得再按勾选集条件渲染——那正是本次要改掉的「勾选才出现」。",
  );
});

test("零勾选时四个动作一律置灰（重新评估 / 批量体检 / 批量跳过 / 清除选择）", () => {
  // 计数位先说清「未选择」，四个按钮再共用同一口径的 disabled 判定。
  assert.match(CODE, /t\("pipeline\.batchNoneSelected"\)/);
  const gated = CODE.match(/disabled=\{[^}]*\bneedSelection\b[^}]*\}/g) ?? [];
  assert.equal(gated.length, 4, `应有 4 个按钮的 disabled 挂上 needSelection，实得 ${gated.length} 个`);
});

test("i18n：batchNoneSelected / batchNeedSelection 中英成对，且退役的 batchHint* 不再被引用", () => {
  for (const key of ["pipeline.batchNoneSelected", "pipeline.batchNeedSelection"]) {
    const hits = DICT.match(new RegExp(`"${key}":`, "g")) ?? [];
    assert.equal(hits.length, 2, `${key} 必须在 en/zh 两份字典各有一处`);
  }
  // 常显后没有任何调用方再取提示语；留着字典键只会误导下一个改这条的人。
  for (const key of ["pipeline.batchHint", "pipeline.batchHintEvaluated"]) {
    assert.doesNotMatch(DICT, new RegExp(`"${key}":`), `${key} 已随常显改动退役，不应留在字典里`);
    assert.doesNotMatch(CODE, new RegExp(`t\\("${key}"\\)`), `${key} 不应再被组件引用`);
  }
});
