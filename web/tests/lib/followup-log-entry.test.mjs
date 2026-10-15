// followup-log-entry 源码守卫：报告页「记录跟进」入口的三个用户可见事实
// （ADR-0075）——入口按 entry 门控渲染、弹窗复用 LogDialog（成功走 onLogged
// 轻提示）、提示键 zh/en 成对。量结构不量散文：先剥注释再计数。
//
// Run:  node --test web/tests/lib/followup-log-entry.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");

/** 剥掉 /* *\/ 块注释与 // 行内注释，守卫量结构不量散文。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
}

const BUTTON = stripComments(read("components/followups/log-followup-button.tsx"));
const VIEW = stripComments(read("components/report-view.tsx"));
const DICT = read("lib/i18n/clusters/followups.ts");

test("入口按 entry 门控渲染：ReportView 仅在 followupEntry 存在时渲染按钮", () => {
  assert.ok(
    VIEW.includes("{followupEntry && <LogFollowupButton entry={followupEntry} />}"),
    "report-view.tsx 必须 `{followupEntry && <LogFollowupButton …/>}` 门控渲染（ADR-0075 决议 2）",
  );
});

test("弹窗复用：按钮渲染 LogDialog，成功路径把轻提示接到 onLogged", () => {
  assert.ok(BUTTON.includes("<LogDialog"), "按钮必须复用 LogDialog（决议 3）");
  assert.ok(BUTTON.includes("onLogged="), "成功路径必须经由 LogDialog 的 onLogged（决议 5）");
  assert.ok(
    BUTTON.includes('t("followups.loggedToast")'),
    "轻提示文案必须取自 i18n 键 followups.loggedToast（决议 5）",
  );
  assert.ok(
    BUTTON.includes("setTimeout(() => setToast(null), 5000)"),
    "轻提示必须 5 秒后自动消失（决议 5）",
  );
});

test("提示键 zh/en 成对：followups.loggedToast 两份字典各一处", () => {
  const hits = (DICT.match(/"followups\.loggedToast":/g) ?? []).length;
  assert.equal(hits, 2, `followups.loggedToast 必须在 en/zh 各出现一次（当前 ${hits}）`);
});
