// 配置类台账的 meta 组装（web/src/lib/core/op-log-meta.mjs）单测。
//
// 这一层只做一件事：把「改了哪几个键」压成一条 fields 条目。它的纪律不是格式而是
// 隐私——cv.md / config/profile.yml / portals.yml 的值里有本机绝对路径、邮箱、密钥，
// 台账只记键名。所以断言里有两条是硬要求：只出现键、截断上限固定。
//
// Run: node --test web/tests/lib/op-log-meta.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_CONFIG_FIELDS, buildConfigMeta } from "../../src/lib/core/op-log-meta.mjs";

test("空 fields 不产生 fields 条目", () => {
  assert.deepEqual(buildConfigMeta(undefined), []);
  assert.deepEqual(buildConfigMeta([]), []);
  assert.deepEqual(buildConfigMeta(null, []), []);
});

test("全空白字段被丢弃，不占位也不留下空串", () => {
  assert.deepEqual(buildConfigMeta(["", "   ", "\t"]), []);
  // 非字符串但存在 → 走 String()，null/undefined 当缺失
  assert.deepEqual(buildConfigMeta(["a", null, undefined, "", "  b  "]), [{ k: "fields", v: "a, b" }]);
});

test("字段数封顶 MAX_CONFIG_FIELDS，顺序保持提交顺序", () => {
  const many = Array.from({ length: MAX_CONFIG_FIELDS + 5 }, (_, i) => `k${i}`);
  const meta = buildConfigMeta(many);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].v, many.slice(0, MAX_CONFIG_FIELDS).join(", "));
  assert.equal(MAX_CONFIG_FIELDS, 12);
});

test("只记键名：值即便被误当字段传进来也不会自动展开成 value 形式", () => {
  // 键名里带点/下划线是正常的（title_filter.positive）；这里防的是有人把
  // `email=xxx@yyy` 整串当字段塞进来——它会被原样写入，所以上游必须只传键。
  const meta = buildConfigMeta(["remote", "compMin"]);
  assert.deepEqual(meta, [{ k: "fields", v: "remote, compMin" }]);
  assert.equal(meta.some((m) => m.k === "value" || m.k === "values"), false);
});

test("调用方给的 meta 排在 fields 之前，且不被改动", () => {
  const own = [
    { k: "positive", v: "19" },
    { k: "negative", v: "180" },
  ];
  const meta = buildConfigMeta(["title_filter.positive"], own);
  assert.deepEqual(meta, [...own, { k: "fields", v: "title_filter.positive" }]);
  assert.deepEqual(own, [
    { k: "positive", v: "19" },
    { k: "negative", v: "180" },
  ]);
});
