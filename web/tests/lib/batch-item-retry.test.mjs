// 批量评估失败子项重试的纯逻辑测试（ADR-0093）。
// 零 DOM 依赖：入参是最小 JobItem / Job 形状，组件侧只做事件接线。
//
// Run:  node --test tests/lib/batch-item-retry.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { canRetryBatchItem, hasLiveEvaluateForUrl } from "../../src/lib/batch-item-retry.mjs";

const failed = {
  key: "https://jobs.example.com/roles/123",
  label: "https://jobs.example.com/roles/123",
  ok: false,
  reason: "the run hit an error before finishing — re-run it to verify",
  ts: 1,
};

test("canRetryBatchItem：带 reason 的失败 URL 项可重试", () => {
  assert.equal(canRetryBatchItem(failed), true);
});

test("canRetryBatchItem：成功项不可重试", () => {
  assert.equal(canRetryBatchItem({ ...failed, ok: true, reason: undefined }), false);
});

test("canRetryBatchItem：skipped 项不算失败，不可重试", () => {
  assert.equal(canRetryBatchItem({ ...failed, skipped: true, reason: "skipped-running" }), false);
});

test("canRetryBatchItem：无 reason 的 item-running 占位不可重试", () => {
  assert.equal(canRetryBatchItem({ key: "https://x/a", label: "https://x/a", ok: false, ts: 1 }), false);
});

test("canRetryBatchItem：checkup 的 tracker# key 不可重试（需前哨，本 ADR 不做）", () => {
  assert.equal(canRetryBatchItem({ key: "42", label: "#42 公司", ok: false, reason: "no-via", ts: 1 }), false);
});

test("canRetryBatchItem：非 http(s) 的 key 保守拒绝", () => {
  for (const key of ["ftp://x/a", "file:///tmp/a", "https://", ""]) {
    assert.equal(canRetryBatchItem({ ...failed, key }), false, key);
  }
});

test("canRetryBatchItem：null/undefined 保守拒绝", () => {
  assert.equal(canRetryBatchItem(null), false);
  assert.equal(canRetryBatchItem(undefined), false);
});

test("hasLiveEvaluateForUrl：同 URL 的 running/queued evaluate 卡视为在跑", () => {
  const url = failed.key;
  assert.equal(hasLiveEvaluateForUrl([{ kind: "evaluate", input: url, status: "running" }], url), true);
  assert.equal(hasLiveEvaluateForUrl([{ kind: "evaluate", input: url, status: "queued" }], url), true);
});

test("hasLiveEvaluateForUrl：终态卡与其他 kind 不算在跑", () => {
  const url = failed.key;
  assert.equal(hasLiveEvaluateForUrl([{ kind: "evaluate", input: url, status: "done" }], url), false);
  assert.equal(hasLiveEvaluateForUrl([{ kind: "evaluate", input: url, status: "error" }], url), false);
  assert.equal(hasLiveEvaluateForUrl([{ kind: "checkup", input: url, status: "running" }], url), false);
  assert.equal(hasLiveEvaluateForUrl([{ kind: "evaluate", input: "https://other", status: "running" }], url), false);
});

test("hasLiveEvaluateForUrl：空清单/空 URL 不炸且返回 false", () => {
  assert.equal(hasLiveEvaluateForUrl([], failed.key), false);
  assert.equal(hasLiveEvaluateForUrl(null, failed.key), false);
  assert.equal(hasLiveEvaluateForUrl([{ kind: "evaluate", input: "", status: "running" }], ""), false);
});