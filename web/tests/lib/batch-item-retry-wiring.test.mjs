// 单项重试的接线守卫（ADR-0093）：组件无 DOM 测试基建，用源码字符串锁定
// 「失败项 → BatchItemRetryButton → startJob(kind=evaluate, input=失败项 URL,
// 引擎沿用父批量快照)」这条链，以及 en/zh 文案键对称，防止后续重构悄悄拆掉。
//
// Run:  node --test tests/lib/batch-item-retry-wiring.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const LIST = read("../../src/components/jobs/batch-item-list.tsx");
const BUTTON = read("../../src/components/jobs/batch-item-retry-button.tsx");
const STORE = read("../../src/components/jobs/job-store.tsx");
const I18N = read("../../src/lib/i18n/clusters/jobs.ts");

test("BatchItemList 只在失败且未跳过的子项渲染重试按钮", () => {
  assert.match(LIST, /!it\.ok && !it\.skipped && /);
  assert.match(LIST, /<BatchItemRetryButton/);
  assert.match(LIST, /import \{ BatchItemRetryButton \}/);
});

// ADR-0093 修订 1：父批量终态（done/error）要传到子项判定，无 reason 的
// 「结论丢失」占位才放行；三个渲染面（/jobs 行、详情页、ledger-only 视图）都要传。
test("终态信号从三个渲染面透传到子项判定", () => {
  assert.match(LIST, /parentTerminal = false/);
  assert.match(LIST, /parentTerminal=\{parentTerminal\}/);
  assert.match(BUTTON, /canRetryBatchItem\(item, \{ parentTerminal \}\)/);
  const JOBS_PAGE = read("../../src/app/jobs/page.tsx");
  const DETAIL_PAGE = read("../../src/app/jobs/[id]/page.tsx");
  assert.match(JOBS_PAGE, /parentTerminal=\{j\.status === "error" \|\| j\.status === "done"\}/);
  assert.match(DETAIL_PAGE, /parentTerminal=\{job\.status === "error" \|\| job\.status === "done"\}/);
  assert.match(DETAIL_PAGE, /model=\{e\.model\} parentTerminal \/>/);
});

test("重试按钮派发独立 evaluate worker：input = 子项 URL，引擎取父批量快照", () => {
  assert.match(BUTTON, /kind: "evaluate"/);
  assert.match(BUTTON, /input: item\.key/);
  assert.match(BUTTON, /cliId,\s*\n\s*model,/, "引擎快照必须随派发透传");
  assert.match(BUTTON, /hasLiveEvaluateForUrl/, "同 URL 在跑时须拦重复派发");
});

test("job-store 的 startJob 优先使用传进来的引擎快照", () => {
  assert.match(STORE, /opts\.cliId \? \{ cliId: opts\.cliId, model: opts\.model \} : await resolveEngineFallback\(\)/);
});

test("i18n：单项重试文案在 en/zh 两份字典里键完全对齐", () => {
  const keys = [
    "jobs.batchItemRetry",
    "jobs.batchItemRetryHint",
    "jobs.batchItemRetryRunning",
    "jobs.batchItemRetryTitle",
    "jobs.batchItemNoConclusion",
  ];
  for (const key of keys) {
    const hits = I18N.split(`"${key}":`).length - 1;
    assert.equal(hits, 2, `${key} 必须在 en/zh 各出现一次`);
  }
});