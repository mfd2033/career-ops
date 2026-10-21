// 周投递节奏 (CO-52) 的纯逻辑测试 —— 直接引 weekly-pace.mjs（生产代码同一份），
// 并加一条与核心 stats.mjs isoWeek 的对齐守卫：两处 weekCounts 必须把同一个日期
// 归到同一个 ISO 周，否则 CLI 报表和 Analytics 卡片会对同一条投递给出两个读数。
//
// Run:  node --test tests/lib/weekly-pace.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeeklyPace, isoWeek } from "../../src/lib/weekly-pace.mjs";
import { submittedDatesFromStatusLog } from "../../src/lib/status-log.mjs";
import { submittedDatesFromStatusLog as coreSubmittedDates } from "../../../status-log.mjs";
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

// 漂移守卫：status-log 解析器是根版 + web 副本两份实现（turbopack.root 禁跨根
// import，见 web/src/lib/status-log.mjs 头注）。同一输入必须产出完全一致的 Map。
test("web status-log 解析器与根版逐行一致（防副本漂移）", () => {
  const log = [
    "\uFEFFnum\tdate\tfrom\tto\tsource\tnote", // BOM
    "5001\t2026-06-10\tEvaluated\tApplied\tset-status\t",
    "5002\t2026-06-11\tEvaluated\tApplied\tweb\t",
    "5002\t2026-06-09\tDiscarded\tApplied\tset-status\tre-applied: earliest wins",
    "5003\t2026-06-12\tApplied\tResponded\tweb\t",
    "5004\t2026-06-12\tEvaluated\tSKIP\tset-status\tnever submitted",
    "bad-line",
    "5005\tnot-a-date\tEvaluated\tApplied\tweb\t",
  ].join("\n");
  const tokens = ["APPLIED", "RESPONDED", "INTERVIEW", "OFFER", "HIRED", "REJECTED"];
  const mine = [...submittedDatesFromStatusLog(log, tokens)].sort((a, b) => a[0] - b[0]);
  const theirs = [...coreSubmittedDates(log, tokens)].sort((a, b) => a[0] - b[0]);
  assert.deepEqual(mine, theirs);
  assert.deepEqual(mine, [
    [5001, "2026-06-10"],
    [5002, "2026-06-09"], // 重投取最早
    [5003, "2026-06-12"], // Responded 也算真实投递过
  ]);
});

// 投递日口径（CO-52 修订）：status-log 有首次转入投递态的事件日期 → 按事件日
// 分桶（评估一周后真正投出的行计入实际投递周）；无记录回退行 Date。
test("statusLog 事件日期优先于行 Date，无记录回退行 Date", () => {
  const rows = [
    { n: 5001, date: "2026-06-01", status: "Applied" }, // 评估上周，实际本周投出
    { n: 5002, date: "2026-06-10", status: "Applied" }, // 台账无记录 → 回退行 Date
  ];
  const statusLog = [
    "num\tdate\tfrom\tto\tsource\tnote",
    "5001\t2026-06-10\tEvaluated\tApplied\tset-status\t",
    "", // 容忍尾随空行
  ].join("\n");
  const p = computeWeeklyPace(rows, { target: 8, weeks: 1, now: NOW, statusLog });
  assert.equal(p.thisWeekCount, 2); // 5001 按 06-10 事件日、5002 回退行 Date，同落本周
  // 无台账 → 旧行为：仅 06-10 一条落本周，上周评估的 5001 不进本周桶。
  const fallback = computeWeeklyPace(rows, { target: 8, weeks: 1, now: NOW });
  assert.equal(fallback.thisWeekCount, 1);
});
