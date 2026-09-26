// 数据分析页下钻跳转（ADR-0067）——工单 01：阶段条形下钻的源码守卫。
//
// 守卫的是三件不可漂的事：
//   1. 下钻 href 只许经共享上下文序列化器 buildContextQuery 生成——分析页与
//      管道页对同一个 URL 上下文只允许存在一种写法（决议 6）。
//   2. 条形行的可点判定是 `href != null && value > 0`——零计数行是死交互，
//      不给链接（决议 1 的护栏）。
//   3. 头条统计卡永远不接 href——ever 累计语义与管道 tab 现状语义对不上，
//      跳了必骗人（决议 1）。
//
// 与 pipeline-single-nav-entry.test.mjs 同一手法：剥注释后量结构，不数散文。
//
// Run:  node --test tests/lib/analytics-drilldown.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE = readFileSync(new URL("../../src/app/analytics/page.tsx", import.meta.url), "utf8");
const VIEW = readFileSync(new URL("../../src/components/analytics/analytics-view.tsx", import.meta.url), "utf8");
const I18N = readFileSync(new URL("../../src/lib/i18n/clusters/analytics.ts", import.meta.url), "utf8");

/** 剥掉 JSX/JS 注释，守卫量结构不量散文。 */
function stripComments(src) {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
}

const PAGE_CODE = stripComments(PAGE);
const VIEW_CODE = stripComments(VIEW);

function count(src, needle) {
  return src.split(needle).length - 1;
}

test("阶段条形 href 只经 buildContextQuery 生成，不手拼查询串", () => {
  assert.ok(
    PAGE_CODE.includes('buildContextQuery({ tab: key })'),
    "stage href 必须由共享序列化器 buildContextQuery 生成（ADR-0067 决议 6）",
  );
  assert.ok(
    PAGE_CODE.includes('buildContextQuery({ tab: "ALL", min: b.min, max: b.max })'),
    "分数桶 href 必须携区间边界经共享序列化器生成（ADR-0067 决议 2/6）",
  );
  assert.ok(
    PAGE_CODE.includes('buildContextQuery({ tab: "ALL", company: name })'),
    "Top 公司 href 必须携原始公司名经共享序列化器生成（ADR-0067 决议 2/6）",
  );
  assert.ok(!PAGE_CODE.includes('"?tab='), "分析页不得手拼 ?tab= —— 第二份 URL 拼接必然漂移");
  assert.ok(!PAGE_CODE.includes("`?tab="), "同上（模板字符串形态）");
});

test("条形行的可点门只有一处：href 存在且计数非零", () => {
  assert.equal(
    count(VIEW_CODE, "href != null && value > 0"),
    1,
    "`href != null && value > 0` 门必须恰好一处——0 计数不可点，非门路径不得另开链接",
  );
});

test("头条统计卡不吃 href（ever 语义不跳转）", () => {
  const statCalls = VIEW_CODE.slice(VIEW_CODE.indexOf("<Stat"), VIEW_CODE.indexOf("<Section"));
  assert.ok(statCalls.length > 0, "analytics-view.tsx 结构变化——找不到 <Stat 调用区");
  assert.ok(!statCalls.includes("href"), "Stat 卡带上 href 即违反 ADR-0067 决议 1");
});

test("下钻 tooltip 键在 en/zh 词典成对存在", () => {
  assert.equal(count(I18N, '"analytics.drill.viewInPipeline"'), 2, "tooltip 键必须 en/zh 各一处");
  assert.ok(I18N.includes("{n}"), "tooltip 必须带条数插值，用户点前知道会看到多少行");
});
