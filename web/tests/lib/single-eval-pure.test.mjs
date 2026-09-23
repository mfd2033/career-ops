// single-eval-pure 纯逻辑单测（ADR-0051 决议 2/6/7/11）：
// 能力位选路 + /api/events 帧折叠成 popup stage + VERDICT/ERROR 抽取与终态唯一性。
// 无 chrome / DOM 依赖，直接 import extension/single-eval-pure.js。
//
// Run:  node --test web/tests/lib/single-eval-pure.test.mjs
//
// 与同族扩展侧测试（badge-pure / scan-pure / wrapup-pure）同级，由 test-all.mjs
// 的 web/tests/lib 批次一并门住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "single-eval-pure.js")).href);
const {
  CAP_SINGLE_EVAL_INLINE_JD,
  pickEvalRoute,
  createRunState,
  consumeRunEvent,
  composeFailureNotice,
  lastVerdict,
} = mod.default ?? mod;

const URL = "https://www.liepin.com/job/1998394056.shtml";

/** 依次喂事件，返回最终状态与所有产出的 stage 事件。 */
function feed(events, url = URL) {
  let state = createRunState(url);
  const out = [];
  for (const ev of events) {
    const r = consumeRunEvent(state, ev);
    state = r.state;
    out.push(...r.events);
  }
  return { state, out };
}

// ---- pickEvalRoute：能力位决定链路 ----------------------------------------

test("服务端宣告能力位 → 走单任务 /api/run", () => {
  assert.equal(pickEvalRoute({ capabilities: [CAP_SINGLE_EVAL_INLINE_JD] }), "run");
});

test("老服务端（无 capabilities 字段）→ 回落批量路", () => {
  for (const payload of [{}, { capabilities: [] }, { capabilities: ["other"] }, null, undefined, "junk", 42]) {
    assert.equal(pickEvalRoute(payload), "batch", `${JSON.stringify(payload)} must fall back to batch`);
  }
});

test("capabilities 脏形状（对象/字符串）不得误判为支持", () => {
  // 字符串上有 indexOf，看起来"像"能用——但只有数组才算宣告过能力。
  assert.equal(pickEvalRoute({ capabilities: CAP_SINGLE_EVAL_INLINE_JD }), "batch");
  assert.equal(pickEvalRoute({ capabilities: { 0: CAP_SINGLE_EVAL_INLINE_JD } }), "batch");
});

// ---- 最小映射：status/text 透传，tool/keepalive 丢弃 ----------------------

test("status 事件映成 popup 的 stage:status，含 phase: 前缀原样透传", () => {
  const { out } = feed([{ seq: 1, type: "status", label: "phase:queued" }, { seq: 2, type: "status", label: "Reading modes/oferta.md" }]);
  assert.deepEqual(out, [
    { stage: "status", text: "phase:queued" },
    { stage: "status", text: "Reading modes/oferta.md" },
  ]);
});

test("tool 与 keepalive 事件不产出任何 popup 事件", () => {
  const { out } = feed([{ seq: 1, type: "tool", name: "WebFetch" }, { seq: 2, type: "keepalive" }, { seq: 3, type: "unknown-future" }]);
  assert.deepEqual(out, []);
});

// ---- seq 重放去重（总线连上会整段回放缓冲）------------------------------

test("seq 不增的事件被丢弃：重连回放不重复计数", () => {
  const { out } = feed([
    { seq: 1, type: "status", label: "a" },
    { seq: 1, type: "status", label: "a" },
    { seq: 2, type: "status", label: "b" },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.text), ["a", "b"]);
});

test("无 seq 的事件照常处理（非 claude 引擎/未知来源不静默吞掉进度）", () => {
  const { out } = feed([{ type: "status", label: "no-seq" }]);
  assert.equal(out.length, 1);
});

// ---- VERDICT → 合成结论行（决议 7）--------------------------------------

test("done 前累积到 VERDICT → 合成一条 item 再发 done", () => {
  const { out } = feed([
    { seq: 1, type: "text", text: "评分完成。\nVERDICT: 4/5 — 强匹配，缺 Kubernetes\n" },
    { seq: 2, type: "done", tokens: 1234 },
  ]);
  assert.deepEqual(out.filter((e) => e.stage === "item"), [{ stage: "item", url: URL, ok: true, score: 4 }]);
  assert.deepEqual(out[out.length - 1], { stage: "done", ok: 1, failed: 0 });
});

test("多条 VERDICT 取最后一条（agent 改口以最后一次为准）", () => {
  const { state } = feed([
    { seq: 1, type: "text", text: "VERDICT: 5/5 — 第一版\n" },
    { seq: 2, type: "text", text: "再看一眼，其实不行\nVERDICT: 2/5 — 经验不匹配\n" },
  ]);
  assert.equal(lastVerdict(state.text).score, 2);
  assert.equal(state.verdict.score, 2);
});

test("无 VERDICT 的 done 只有 done，不造假结论行", () => {
  const { out } = feed([{ seq: 1, type: "text", text: "我把报告写好了。" }, { seq: 2, type: "done" }]);
  assert.ok(!out.some((e) => e.stage === "item"), "must not invent a verdict line");
  assert.deepEqual(out[out.length - 1], { stage: "done", ok: 1, failed: 0 });
});

test("终态只发一次：error 之后再来的 done 不再产出事件", () => {
  const { out } = feed([
    { seq: 1, type: "error", msg: "The CLI produced no output" },
    { seq: 2, type: "done" },
  ]);
  assert.equal(out.filter((e) => e.stage === "done").length, 0);
  assert.equal(out.filter((e) => e.stage === "error").length, 1);
});

// ---- 失败文案：ERROR 行优先，门文案作附注 --------------------------------

test("登录墙失败：worker 的 ERROR 行是主文案，route 门文案进括号", () => {
  const { out } = feed([
    { seq: 1, type: "text", text: 'ERROR: cannot extract JD for liepin.com — extraction via bsk failed (session_failed); provide the JD text inline.\n' },
    { seq: 2, type: "error", msg: "The CLI exited with an error" },
  ]);
  const err = out.find((e) => e.stage === "error").error;
  assert.match(err, /^ERROR: cannot extract JD for liepin\.com/);
  assert.match(err, /The CLI exited with an error/);
  assert.deepEqual(out.find((e) => e.stage === "item"), { stage: "item", url: URL, ok: false, score: null });
});

test("composeFailureNotice: 只有门文案时不编造", () => {
  assert.equal(composeFailureNotice({ msg: "boom", errLine: null }), "boom");
  assert.equal(composeFailureNotice({ msg: "", errLine: "ERROR: x" }), "ERROR: x");
  assert.equal(composeFailureNotice({}), "评估失败");
});

test("长文本累积不丢 VERDICT（8000 字尾巴之前先 latch）", () => {
  const filler = "x".repeat(9000);
  const { state, out } = feed([
    { seq: 1, type: "text", text: `VERDICT: 3/5 — 中段结论\n${filler}` },
    { seq: 2, type: "done" },
  ]);
  assert.equal(state.verdict.score, 3);
  assert.ok(state.text.length <= 8000 + 10, "text tail stays bounded");
  assert.equal(out.filter((e) => e.stage === "item").length, 1);
});
