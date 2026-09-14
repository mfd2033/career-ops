// discovery-card 的薪资展示契约（工单 03 缺陷修复）。
//
// 覆盖浏览器的两件事，都只能从源码断言（.tsx 组件无渲染器可跑，与
// decision-card-cta.test.mjs 同口径）：
//   1. 「薪资未知」的判定来自 isSalaryUnknown(offer)，不是 offer.salaryUnknown；
//   2. 薪资原文与「薪资未知」是两个并列徽章，不是二选一。
//
// Run:  node --test tests/lib/discovery-card-salary-badge.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/components/explore/discovery-card.tsx"),
  "utf8",
);

test("「薪资未知」判定来自 isSalaryUnknown(offer)，不依赖门控打标", () => {
  // offer.salaryUnknown 只在薪资下限门控激活时才置位（落库侧打标，pipeline.md note 用）。
  // 卡片若拿它当展示条件，没填下限的扫描就一个标记都看不到——工单 03 要求「无薪资/
  // 解析失败展示「薪资未知」标记」，与门控是否启用无关。
  assert.match(src, /isSalaryUnknown\(offer\)/, "card must derive the marker from isSalaryUnknown(offer)");
  assert.doesNotMatch(src, /\{offer\.salaryUnknown && \(/, "the marker must not be keyed on the gate tag alone");
});

test("薪资原文与「薪资未知」是并列徽章，不是二选一", () => {
  // 原文能拿到就照常直出（「结果列表展示薪资原文」），同时说明它解析不出数值时不算数。
  // 旧的 if/else 结构把两者做成了互斥：有原文就永不显示标记。
  assert.match(src, /\{offer\.salaryText && \(/, "raw salary text renders on its own condition");
  assert.match(src, /\{salaryUnknown && \(/, "the unknown marker renders on its own condition");
});

test("标记只作用于浏览器采集的卡片", () => {
  // AI 搜索（modes/discover.md）的 offer 压根不带薪资字段，不该被标成「薪资未知」。
  assert.match(src, /offer\.ats === "browser" && isSalaryUnknown\(offer\)/);
});
