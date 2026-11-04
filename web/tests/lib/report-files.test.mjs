// Tests for the shared `{n}-RESERVED.md` predicate. Imports report-files.mjs
// directly — it is THE definition for web/, consumed by both career-ops.ts
// (report lookup) and run-cli-support.mjs (the persistence gate), so a change
// here moves both consumers at once. That is the point: the two used to carry
// separate copies that already disagreed.
//
// Run:  node --test tests/lib/report-files.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { isReservedReportFile, reportFileIndex } from "../../src/lib/report-files.mjs";

test("a numbered sentinel is reserved", () => {
  // Given: what reserve-report-num.mjs actually writes to claim a number.
  assert.equal(isReservedReportFile("041-RESERVED.md"), true);
  assert.equal(isReservedReportFile("7-RESERVED.md"), true);
});

test("a real report is never reserved", () => {
  assert.equal(isReservedReportFile("027-cd-invest-2026-08-11.md"), false);
});

test("only a NUMBERED sentinel counts — the case the two old copies disagreed on", () => {
  // Given: nothing produces this today, but the predicates differed on it, which
  // is exactly the drift one definition exists to prevent.
  assert.equal(isReservedReportFile("notes-RESERVED.md"), false);
  assert.equal(isReservedReportFile("RESERVED.md"), false);
});

test("the match is anchored, so a lookalike name is not reserved", () => {
  assert.equal(isReservedReportFile("041-RESERVED.md.bak"), false);
  assert.equal(isReservedReportFile("041-RESERVED-notes.md"), false);
  assert.equal(isReservedReportFile("x041-RESERVED.md"), false);
});

test("only the basename is examined, so a full path works", () => {
  // Given: career-ops.ts passes a resolved path, run-cli-support.mjs a bare name.
  assert.equal(isReservedReportFile("/root/reports/041-RESERVED.md"), true);
  assert.equal(isReservedReportFile("/root/reports/027-acme-2026-08-11.md"), false);
});

// reportFileIndex（ADR-0098 决议 7）：报告定位原先在逐行循环里 readdir，816 行 =
// 816 次目录扫描。索引规则必须与 resolveReportPathFor 的兜底完全同源，否则
// 「扫目录找」与「查索引找」会给出不同报告。
test("报告号取文件名前缀整数，补零与不补零都认", () => {
  const index = reportFileIndex(["007-acme-2026-08-11.md", "64-beta.md"]);
  assert.equal(index.get(7), "007-acme-2026-08-11.md");
  assert.equal(index.get(64), "64-beta.md");
});

test("跳过 {n}-RESERVED.md 哨兵与非 .md 文件", () => {
  const index = reportFileIndex(["041-RESERVED.md", "042-real.md", "043-x.txt", "notes.md"]);
  assert.equal(index.has(41), false, "哨兵不是报告：占号期间不该被当成报告解析");
  assert.equal(index.get(42), "042-real.md");
  assert.equal(index.size, 1, "非 .md 与无数字前缀的名字不进索引");
});

test("同号多份时首个胜出（与 readdir 顺序下的 find 一致）", () => {
  // 真实场景：手写的 064-… 与工具写的 064-…-v2 同时存在。旧实现 files.find()
  // 取目录顺序里的第一个，索引必须给出同一份，否则两条读路径会各看一份报告。
  const index = reportFileIndex(["064-first.md", "064-second.md"]);
  assert.equal(index.get(64), "064-first.md");
});

test("空清单/脏数据不抛错，只得到一个空索引", () => {
  assert.equal(reportFileIndex([]).size, 0);
  assert.equal(reportFileIndex(null).size, 0);
  assert.equal(reportFileIndex(["abc.md", ""].filter(Boolean)).size, 0);
});
