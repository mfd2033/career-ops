// 批量折叠摘要的纯计数逻辑（ADR-0045 决议 9）：从逐项 items 现算
// 「n 项 · x 成功 · y 失败」，不新增存储。skipped（skipped-running）单列、
// 不算失败（ADR-0041 决议 5 口径）；n 取 total 与 items 数的较大者（快照被
// cap 截断时总数不失真）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { batchSummary } from "../../src/lib/batch-summary.mjs";

const it = (extra = {}) => ({ key: "k", label: "k", ok: true, skipped: false, ...extra });

test("成功/失败/跳过分开计数（skipped 不算失败）", () => {
  const items = [it(), it({ ok: false }), it({ ok: false, skipped: true }), it()];
  assert.deepEqual(batchSummary(items, undefined), { n: 4, ok: 2, failed: 1, skipped: 1, hasItems: true });
});

test("n 取 total 与 items 的较大者（快照截断/运行中部分完成都成立）", () => {
  assert.equal(batchSummary([it(), it()], 20).n, 20);
  assert.equal(batchSummary([it()], 0).n, 1);
  assert.equal(batchSummary([], 5).n, 5);
});

test("空/畸形输入：hasItems=false（展示端据此不给展开箭头），绝不抛", () => {
  for (const bad of [undefined, null, [], "nope"]) {
    const s = batchSummary(bad, undefined);
    assert.equal(s.hasItems, false);
    assert.equal(s.ok, 0);
    assert.equal(s.failed, 0);
  }
  assert.equal(batchSummary([null, undefined, it()], undefined).ok, 1);
});
