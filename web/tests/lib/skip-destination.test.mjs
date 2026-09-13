// Run:  node --test tests/lib/skip-destination.test.mjs
//
// 锁定报告页「跳过」按钮的落点决策：写盘 Discarded 后前进。replace（不 push）让
// 被跳过的这份不进返回栈；深链报告页没有列表上下文，维持旧行为 push 回首页。
import { test } from "node:test";
import assert from "node:assert/strict";

import { skipDestination } from "../../src/lib/skip-destination.mjs";

test("skipDestination: 有下一份 → replace 到下一份（带上列表上下文）", () => {
  assert.deepEqual(
    skipDestination({ nextHref: "/pipeline/42?tab=ALL", fallbackHref: "/pipeline?tab=ALL", hasListContext: true }),
    { href: "/pipeline/42?tab=ALL", replace: true },
  );
});

test("skipDestination: 已是最后一份 → replace 回列表页（保留 tab/排序/搜索）", () => {
  assert.deepEqual(
    skipDestination({ nextHref: null, fallbackHref: "/pipeline?tab=EVALUATED&sort=score", hasListContext: true }),
    { href: "/pipeline?tab=EVALUATED&sort=score", replace: true },
  );
});

test("skipDestination: 兜底链接缺失 → 回默认列表", () => {
  assert.deepEqual(skipDestination({ nextHref: null, hasListContext: true }), { href: "/pipeline", replace: true });
  assert.deepEqual(
    skipDestination({ nextHref: null, fallbackHref: "", hasListContext: true }),
    { href: "/pipeline", replace: true },
  );
});

test("skipDestination: 深链页（无列表上下文）维持旧行为 push 回首页，忽略 nextHref", () => {
  assert.deepEqual(
    skipDestination({ nextHref: "/pipeline/42?tab=ALL", fallbackHref: "/pipeline?tab=ALL", hasListContext: false }),
    { href: "/", replace: false },
  );
});

test("skipDestination: 空字符串 nextHref 视同无下一份", () => {
  assert.deepEqual(
    skipDestination({ nextHref: "", fallbackHref: "/pipeline?tab=ALL", hasListContext: true }),
    { href: "/pipeline?tab=ALL", replace: true },
  );
});
