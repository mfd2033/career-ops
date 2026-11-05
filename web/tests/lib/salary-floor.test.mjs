// Tests for salary-floor.mjs — the pure conversion between the CLI scanner's
// ANNUAL `portals.yml salary_filter.min` and the Explorer's MONTHLY-K salary
// floor (`ExploreFilters.zhSalaryMin`), which is what the browser discovery gate
// actually reads (browser-search.mjs::applyBrowserSalaryGate).
//
// Regression this locks down: seedExploreFilters never seeded the salary floor,
// so a config saying "年薪 24 万" (20K/月) ran the browser hunt with the gate
// OFF — 5-6K cards landed in results and in scan-history, then surfaced under
// the home dashboard's 「本周新匹配」.
//
// Run: node --test tests/lib/salary-floor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { monthlyFloorKFromSalaryFilter } from "../../src/lib/salary-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("年薪 240000 CNY → 月薪 20K（用户实际配置）", () => {
  assert.equal(monthlyFloorKFromSalaryFilter({ min: 240000, max: 0, currency: "CNY" }), 20);
});

test("currency 缺省按人民币处理（CLI 侧此时不限币种）", () => {
  assert.equal(monthlyFloorKFromSalaryFilter({ min: 240000 }), 20);
});

test("CNY / RMB / cny 大小写与写法都认", () => {
  for (const currency of ["CNY", "RMB", "cny", " rmb "]) {
    assert.equal(monthlyFloorKFromSalaryFilter({ min: 180000, currency }), 15, currency);
  }
});

test("按 12 个月折算，并保留 1 位小数（与 ExploreFilters 清洗口径一致）", () => {
  assert.equal(monthlyFloorKFromSalaryFilter({ min: 300000, currency: "CNY" }), 25);
  assert.equal(monthlyFloorKFromSalaryFilter({ min: 250000, currency: "CNY" }), 20.8);
  assert.equal(monthlyFloorKFromSalaryFilter({ min: 6000, currency: "CNY" }), 0.5);
});

test("min 是数字字符串也接受（YAML 引号写法的容错）", () => {
  assert.equal(monthlyFloorKFromSalaryFilter({ min: "240000", currency: "CNY" }), 20);
});

test("非人民币不播种：拿 USD 年薪水比 RMB 月薪会让门不可解释", () => {
  assert.equal(monthlyFloorKFromSalaryFilter({ min: 100000, currency: "USD" }), undefined);
  assert.equal(monthlyFloorKFromSalaryFilter({ min: 100000, currency: "EUR" }), undefined);
});

test("推不出下限时不播种：min 缺失 / 为 0 / 只有 max", () => {
  assert.equal(monthlyFloorKFromSalaryFilter({ max: 500000, currency: "CNY" }), undefined);
  assert.equal(monthlyFloorKFromSalaryFilter({ min: 0, max: 0, currency: "CNY" }), undefined);
  assert.equal(monthlyFloorKFromSalaryFilter({}), undefined);
});

test("非法输入一律不播种，绝不抛", () => {
  for (const bad of [null, undefined, "240000", 42, [], { min: -5 }, { min: "abc" }, { min: NaN }]) {
    assert.equal(monthlyFloorKFromSalaryFilter(bad), undefined, String(bad));
  }
});

// Guard against the wiring silently disappearing: the pure function is useless
// unless seedExploreFilters actually seeds zhSalaryMin from it.
test("seedExploreFilters 把换算结果播种进 zhSalaryMin", () => {
  const src = readFileSync(join(here, "../../src/lib/core/portals.ts"), "utf8");
  assert.match(src, /monthlyFloorKFromSalaryFilter\(portals\.salary_filter\)/);
  assert.match(src, /filters\.zhSalaryMin = seededSalaryFloor/);
});
