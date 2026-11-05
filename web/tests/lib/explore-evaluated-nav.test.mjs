// 探索页「已评估 · 查看报告」按钮的落点回归：
// 一律跳报告页 /report/{n}（ADR-0018 同口径），绝不落回工作器任务页 /jobs/{id}。
// 缺陷原状：本次会话刚评估完的行不在页面加载时的追踪表快照里（evaluatedN 缺），
// 按钮退到 `/jobs/${job.id}`——把用户带到了工作器的评估任务页而不是报告。
// 修复：快照命中 → /report/{evaluatedN}；快照未刷新 → resolveJobReportNum 的
// URL 维度（任务记录 + /api/report-status 索引，评估落定即失效重拉）解析报告号；
// 两处都解析不出 → /pipeline 列表。
//
// Run:  node --test web/tests/lib/explore-evaluated-nav.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveJobReportNum } from "../../src/lib/report-num.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cardSrc = readFileSync(
  join(here, "../../src/components/explore/discovery-card.tsx"),
  "utf8",
);

test("探索卡片/行不再链接到工作器任务页 /jobs/{id}", () => {
  assert.ok(!cardSrc.includes("/jobs/${job.id}"), "「查看报告」按钮不得把用户带回工作器任务页");
});

test("按钮落点是报告页 /report/{n}（快照命中与刚评估完两个分支都在）", () => {
  assert.ok(cardSrc.includes("/report/${evaluatedN}"), "追踪表快照命中 → /report/{evaluatedN}");
  assert.ok(cardSrc.includes("/report/${doneReportN}"), "快照未刷新 → URL 维度解析出的报告号");
});

test("resolveJobReportNum：evaluate 任务凭职位 URL 从 /api/report-status 索引解析报告号", () => {
  const job = { id: "j1", kind: "evaluate", input: "https://www.zhipin.com/job_detail/52df484a60f195910nx62dS4FFBU.html?securityId=abc&ka=x" };
  const reports = { "https://www.zhipin.com/job_detail/52df484a60f195910nx62dS4FFBU.html": { score: "4", reportNum: "1164" } };
  assert.equal(resolveJobReportNum(job, reports), "1164");
});

test("索引未加载（null）时解析为 null → 组件落 /pipeline 列表，不猜号", () => {
  const job = { id: "j1", kind: "evaluate", input: "https://www.zhipin.com/job_detail/52df484a60f195910nx62dS4FFBU.html" };
  assert.equal(resolveJobReportNum(job, null), null);
});
