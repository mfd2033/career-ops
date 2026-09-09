// scan-max 每站采集上限配置单测：默认值 / 规整 / 读写持久化。
// 猎聘分页型默认 1200（防大关键词撞 400 截末页），BOSS/智联懒加载保持 400。
//
// Run:  node --test tests/lib/scan-max.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { SCAN_MAX_DEFAULT, cleanScanMax, clampSafe } from "../../src/lib/scan-max.mjs";

test("defaults: liepin 1200, zhipin/zhaopin 400", () => {
  assert.equal(SCAN_MAX_DEFAULT.liepin, 1200);
  assert.equal(SCAN_MAX_DEFAULT.zhipin, 400);
  assert.equal(SCAN_MAX_DEFAULT.zhaopin, 400);
});

test("cleanScanMax keeps only the three known sites with valid numbers", () => {
  const out = cleanScanMax({
    liepin: 2000,
    zhipin: 500,
    zhaopin: "bad", // 非法 → 回落默认
    extra: 999, // 未知站点 → 丢弃
  });
  assert.deepEqual(out, { zhipin: 500, liepin: 2000, zhaopin: 400 });
});

test("cleanScanMax empty/null → all defaults", () => {
  assert.deepEqual(cleanScanMax(null), { ...SCAN_MAX_DEFAULT });
  assert.deepEqual(cleanScanMax(undefined), { ...SCAN_MAX_DEFAULT });
  assert.deepEqual(cleanScanMax({}), { ...SCAN_MAX_DEFAULT });
});

test("cleanScanMax clamps non-positive to defaults; floors fractionals", () => {
  const out = cleanScanMax({ liepin: -5, zhipin: 0, zhaopin: 3.7 });
  assert.equal(out.liepin, 1200); // 负数 → 默认
  assert.equal(out.zhipin, 400); // 0 → 默认
  assert.equal(out.zhaopin, 3); // 小数 → 下取整为正整数（3）
});

test("clampSafe helper mirrors per-site fallback", () => {
  assert.equal(clampSafe(500, 1200), 500);
  assert.equal(clampSafe(undefined, 1200), 1200);
  assert.equal(clampSafe(0, 400), 400);
});