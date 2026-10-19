// 周投递节奏 (CO-52) 的纯逻辑测试 —— 直接引 weekly-pace.mjs（生产代码同一份），
// 并加一条与核心 stats.mjs isoWeek 的对齐守卫：两处 weekCounts 必须把同一个日期
// 归到同一个 ISO 周，否则 CLI 报表和 Analytics 卡片会对同一条投递给出两个读数。
//
// Run:  node --test tests/lib/weekly-pace.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeeklyPace, isoWeek } from "../../src/lib/weekly-pace.mjs";
// 核心口径（唯一事实源）——跨边界引 root stats.mjs，防两份周数学漂移。
import { isoWeek as coreIsoWeek } from "../../../stats.mjs";

const NOW = new Date("2026-06-10T12:00:00Z"); // 当前周落在 06-08 那一周

test("只统计真实投递，忽略未发出的评估/SKIP/放弃", () => {
  const rows = [
    { date: "2026-06-01", status: "Applied" },
    { date: "2026-06-03", status: "Evaluated" }, // 未投，不计
    { date: "2026-06-04", status: "Rejected" }, // 被拒=投过，计
    { date: "2026-06-10", status: "Applied" },
  ];
  const p = computeWeeklyPace(rows, { target: 3, weeks: 2, now: NOW });
  assert.equal(p.thisWeek, isoWeek("2026-06-10"));
  assert.equal(p.thisWeekCount, 1); // 本周仅 06-10 一条 Applied
  assert.equal(p.weeks[0].count, 2); // 上周 Applied + Rejected
  assert.equal(p.weeks[1].count, 1);
  assert.equal(p.belowTarget, true); // 1 < 3
});

test("达标周关闭补扫提示", () => {
  const rows = [{ date: "2026-06-10", status: "Applied" }];
  const p = computeWeeklyPace(rows, { target: 1, weeks: 1, now: NOW });
  assert.equal(p.thisWeekCount, 1);
  assert.equal(p.belowTarget, false);
});

test("空周也产出进度桶，卡片不会消失", () => {
  const p = computeWeeklyPace([], { target: 8, weeks: 4, now: NOW });
  assert.equal(p.weeks.length, 4);
  assert.ok(p.weeks.every((w) => w.count === 0));
  assert.equal(p.thisWeekCount, 0);
  assert.equal(p.belowTarget, true);
});

test("缺日期/坏日期的行被跳过，不污染聚合", () => {
  const rows = [
    { date: "", status: "Applied" },
    { date: "not-a-date", status: "Applied" },
    { date: "2026-06-10", status: "Applied" },
  ];
  const p = computeWeeklyPace(rows, { target: 8, weeks: 1, now: NOW });
  assert.equal(p.thisWeekCount, 1);
});

test("缺省入参不炸（无 profile 目标回退 8）", () => {
  const p = computeWeeklyPace(undefined);
  assert.equal(p.target, 8);
  assert.equal(p.thisWeekCount, 0);
});

// 漂移守卫：web 侧周数学必须与核心 stats.mjs 逐日期一致，尤其跨年边界。
test("isoWeek 与核心 stats.mjs 完全对齐（含跨年边界）", () => {
  const dates = ["2025-12-29", "2026-01-01", "2024-12-31", "2027-01-01", "2026-06-10", "2026-06-01"];
  for (const d of dates) assert.equal(isoWeek(d), coreIsoWeek(d), `isoWeek drift on ${d}`);
});
