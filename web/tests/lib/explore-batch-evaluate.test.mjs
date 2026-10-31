// explore-batch-evaluate.test.mjs — 结果区工具栏的「评估所选 (N)」。
//
// 这个动作比「加入管道」贵得多：每勾选一条就是一个真实评估 worker、一份报告、
// 一次 tracker 写入。所以钉三件事：
//   1. 派发走的批次路径与 /api/batch-evaluate 的 MAX_URLS 同值（改一边不改另一边
//      就会在 21 条时整批 400，而按钮还显示全部勾选）；
//   2. 多条 → batch-evaluate（一次预留连续报告号、统一 merge），单条 → evaluate
//      （与行内评估同路），不能退化成 N 个并发单评估；
//   3. 大批（> EVAL_CONFIRM_ABOVE）先要一次确认，且派发前先入管、派发后清勾。
//
// 这些是组件里的接线，没有可单测的纯函数（读的是 React 状态），所以与
// results-view.test.mjs 同款：断言源码形状。纯逻辑回归（isSelectable 等）在那里。
//
// Run:  node --test web/tests/lib/explore-batch-evaluate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..");
const read = (rel) => readFileSync(join(WEB, "src", ...rel.split("/")), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");

const LIST = read("components/explore/results-list.tsx");
const ROUTE = read("app/api/batch-evaluate/route.ts");
const I18N = read("lib/i18n/clusters/explore.ts");

test("the batch size matches /api/batch-evaluate's MAX_URLS — one number, two files", () => {
  const routeMax = ROUTE.match(/const MAX_URLS = (\d+);/);
  assert.ok(routeMax, "the batch route must still declare MAX_URLS");
  const uiMax = LIST.match(/const EVAL_BATCH_MAX = (\d+);/);
  assert.ok(uiMax, "the toolbar must declare its own batch size");
  assert.equal(
    uiMax[1],
    routeMax[1],
    `results-list EVAL_BATCH_MAX (${uiMax[1]}) must equal the route's MAX_URLS (${routeMax[1]}) — exceeding it turns the whole chunk into a 400`,
  );
});

test("multiple selections dispatch ONE batch-evaluate per chunk, never N parallel single runs", () => {
  const src = flat(LIST);
  assert.match(
    src,
    /for \(let i = 0; i < list\.length; i \+= EVAL_BATCH_MAX\)/,
    "the selection is chunked, not fired row by row",
  );
  assert.match(
    src,
    /kind: "batch-evaluate", input: urls\.join\("\\n"\), urls,/,
    "a chunk goes through batch-evaluate with its urls — the path that reserves a contiguous report range and merges once",
  );
  // 单条仍走单评估，与行内「评估」同路。
  assert.match(
    src,
    /if \(list\.length === 1\) \{[\s\S]*?kind: "evaluate", input: o\.url, page: "\/explore"/,
    "a single selection stays on the single-evaluate path",
  );
});

test("evaluating implies the selection is recorded in the pipeline first", () => {
  const src = flat(LIST);
  assert.match(
    src,
    /void addToPipeline\(list\); \/\/ evaluating implies it's in the pipeline — record it/,
    "batch evaluate must record the offers in pipeline.md before dispatching workers (same rule as the row-level button)",
  );
});

test("a large batch asks once before spending, and the confirmation is scoped to the current selection", () => {
  const src = flat(LIST);
  assert.match(src, /const EVAL_CONFIRM_ABOVE = 3;/, "the silent-fire ceiling is explicit");
  assert.match(
    src,
    /if \(selectedAddable\.length <= EVAL_CONFIRM_ABOVE\) evaluateSelected\(\); else setEvalConfirm\(true\);/,
    "small batches fire directly, large ones switch to confirm mode",
  );
  // 确认态必须随勾选集失效：否则「确认评估 200 个」那颗按钮可能指向另一批行。
  assert.match(
    src,
    /const evalSelectionKey = selectedAddable\.map\(\(o\) => o\.url\)\.join\("\\n"\);[\s\S]*?useEffect\(\(\) => \{ setEvalConfirm\(false\); \}, \[evalSelectionKey\]\)/,
    "changing the selection drops a standing confirmation",
  );
});

test("the dispatch clears the ticks so the same URLs cannot be sent twice", () => {
  const src = flat(LIST);
  assert.match(
    src,
    /setSelected\(\(s\) => \{ const next = new Set\(s\); for \(const o of list\) next\.delete\(o\.url\); return next; \}\)/,
    "after dispatch the batch is consumed — the selection is cleared",
  );
});

test("the new labels exist in both locales", () => {
  for (const key of [
    "explore.results.evaluateSelected",
    "explore.results.evaluateSelectedTitle",
    "explore.results.evaluateConfirm",
    "explore.results.evaluateConfirmTitle",
    "explore.results.evaluateCancel",
    "explore.results.evaluateBatch",
    "explore.results.evaluateBatchSubtitle",
  ]) {
    const hits = (I18N.match(new RegExp(`"${key}":`, "g")) ?? []).length;
    assert.equal(hits, 2, `${key} must exist in both locales`);
  }
});
