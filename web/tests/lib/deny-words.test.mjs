// deny-words.test.mjs — 「拉黑所选」的候选词推导（标题门黑名单的提议端）。
//
// 这个功能把「这条岗位不合适」变成「下次扫描别再搜到类似的」：勾选行的标题里
// 提出候选词，带进 GatePanel 的黑名单草稿。推导只提议、不判定（判定在弹窗的
// 试算里，同一份 buildTitleFilterExplained），但提议本身有可判定的口径：
//
//   1. 括号注脚（（双休）(15-25K)）和招聘噪声前缀（急聘/高薪）不进候选——
//      它们不是岗位名，拉黑它们要么无效要么误伤一大片；
//   2. 中文不做分词：CJK 连串整段一条，交给用户在弹窗里修剪——猜错多毙一批
//      （不可见）比猜粗少毙一批（可见、可改）代价高；
//   3. 去重是大小写不敏感的：portals.yml 的黑名单匹配走 lowercase，同一词两种
//      写法落两条 chip 只会让文件变大、不会多毙一条。

import { test } from "node:test";
import assert from "node:assert/strict";

import { titleDenyCandidates, suggestDenyWords, mergeDenyWords } from "../../src/lib/deny-words.mjs";

test("bracketed footers and hiring-noise prefixes never become deny candidates", () => {
  assert.deepEqual(titleDenyCandidates("仓储主管（双休）"), ["仓储主管"]);
  assert.deepEqual(titleDenyCandidates("课程顾问【浦东新区】"), ["课程顾问"]);
  assert.deepEqual(titleDenyCandidates("销售(15-25K)"), ["销售"]);
  assert.deepEqual(titleDenyCandidates("急聘电话销售"), ["电话销售"]);
  assert.deepEqual(titleDenyCandidates("高薪诚聘外贸业务员"), ["外贸业务员"]);
  // 括号 + 噪声前缀同时出现，两层都剥。
  assert.deepEqual(titleDenyCandidates("急聘仓管员（包吃住）"), ["仓管员"]);
});

test("「招聘」is NOT noise — it is part of real role names (招聘专员)", () => {
  assert.deepEqual(titleDenyCandidates("招聘专员"), ["招聘专员"]);
});

test("CJK runs stay whole; separators inside the title split concurrent roles", () => {
  // 中文没有可靠分词：整段作为一条候选，修剪发生在弹窗里。
  assert.deepEqual(titleDenyCandidates("电话销售专员"), ["电话销售专员"]);
  // 「/」「·」把并列岗位自然断开。
  assert.deepEqual(titleDenyCandidates("销售代表/客服专员"), ["销售代表", "客服专员"]);
  assert.deepEqual(titleDenyCandidates("前台·行政助理"), ["前台", "行政助理"]);
});

test("latin words become candidates; internal symbols survive (PHP/C++/.NET)", () => {
  assert.deepEqual(titleDenyCandidates("Senior PHP Developer"), ["Senior", "PHP", "Developer"]);
  assert.deepEqual(titleDenyCandidates("C++ 工程师"), ["C++", "工程师"]);
  // 单字母不成词（compileKeyword 的子串匹配下单字母会误毙一大片）。
  assert.deepEqual(titleDenyCandidates("A 轮公司财务"), ["轮公司财务"]);
});

test("duplicates fold case-insensitively, first spelling wins, order preserved", () => {
  assert.deepEqual(suggestDenyWords([{ title: "Sales Manager" }, { title: "SALES 主管" }, { title: "manager 培训" }]), ["Sales", "Manager", "主管", "培训"]);
  // 空入参/空标题不出错、不产出。
  assert.deepEqual(suggestDenyWords(null), []);
  assert.deepEqual(suggestDenyWords([{ title: "" }, { title: undefined }]), []);
  assert.deepEqual(titleDenyCandidates(undefined), []);
});

test("mergeDenyWords appends with the same case-folded dedup the panel chips use", () => {
  assert.deepEqual(mergeDenyWords(["销售", "客服"], ["销售", "仓储"]), ["销售", "客服", "仓储"]);
  assert.deepEqual(mergeDenyWords(["Sales", "Manager"], ["SALES"]), ["Sales", "Manager"]);
  // 中西两种词形互不相同：折叠只对同一词形生效，「销售」与「SALES」是两个词。
  assert.deepEqual(mergeDenyWords(["销售"], ["SALES"]), ["销售", "SALES"]);
  assert.deepEqual(mergeDenyWords(null, ["仓储"]), ["仓储"]);
  assert.deepEqual(mergeDenyWords(["销售"], []), ["销售"]);
  // 不改传入值。
  const saved = ["销售"];
  mergeDenyWords(saved, ["仓储"]);
  assert.deepEqual(saved, ["销售"]);
});
