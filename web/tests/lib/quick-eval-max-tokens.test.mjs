// 快评「恒为 0/5」回归测试（诊断记录见 handoff-20261110-084543）。
//
// Bug 链条：quick-eval.ts 的 quickEvaluate 写死 max_tokens: 300。使用中的密钥是
// 推理型模型（u2-flash），思考过程先吃预算，实测 reasoning_content 1039 token、
// finish_reason=length、message.content 为空字符串 → parseQuickResult('') 静默
// 回退成 score 0 / grade 空 / reason 空 → 徽章显示「快评 0/5」，用户看成真实打分。
//
// 锁死三条不变量，防止回归：
//   1. max_tokens 不是写死的 300，而是命名常量且足够推理模型把答案写完（≥1000）。
//   2. content 为空必须抛可读错误（交给插件 quick-eval-error toast），不静默返回 0 分。
//   3. 解析不出分数（raw 为空）同样抛错，不静默返回 0 分。
//
// 说明：quick-eval.ts 是 TS 且顶层 import 带 `@/` 别名的模块，node --test 无法直接
// import，故与 quick-eval-timeout.test.mjs 同口径，用源码文本守卫锁行为。
//
// Run:  node --test web/tests/lib/quick-eval-max-tokens.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVAL = readFileSync(join(ROOT, "web", "src", "lib", "quick-eval.ts"), "utf8");

test("max_tokens 是足够推理模型写完答案的命名常量，不是写死的 300", () => {
  // 旧的致病写法：快评请求体里直接 max_tokens: 300。
  // （probeQuickKey 的 ping 请求 max_tokens: 1 另算，不在本条约束内。）
  assert.ok(
    !/max_tokens\s*:\s*300\b/.test(EVAL),
    "quick-eval.ts 又回到了 max_tokens: 300 —— 推理型模型思考过程会吃满预算、content 为空",
  );
  const m = EVAL.match(/const\s+QUICK_EVAL_MAX_TOKENS\s*=\s*(\d+)/);
  assert.ok(m, "缺少命名常量 QUICK_EVAL_MAX_TOKENS");
  assert.ok(Number(m[1]) >= 1000, `max_tokens ${m[1]} 过小：推理型模型思考后无预算输出正文`);
  assert.ok(
    /max_tokens\s*:\s*QUICK_EVAL_MAX_TOKENS/.test(EVAL),
    "请求体没有引用 QUICK_EVAL_MAX_TOKENS",
  );
});

test("content 为空时抛可读错误，不静默返回 0 分", () => {
  const contentIdx = EVAL.indexOf("const content");
  const callIdx = EVAL.indexOf("parseQuickResult(content)");
  assert.ok(contentIdx >= 0 && callIdx > contentIdx, "找不到 content 的取值与解析位置");
  const seg = EVAL.slice(contentIdx, callIdx);
  assert.ok(
    /throw new Error\(/.test(seg),
    "空 content 必须抛错交给插件 quick-eval-error，静默回退 0 分会让用户误读成真实打分",
  );
  // 错误文案要说清「输出被截断 / 为空」，否则用户不知道该换模型而非重试。
  assert.ok(/截断|为空/.test(seg), "空 content 的报错文案要说明成因（输出被截断或为空）");
});

test("解析不出分数时同样抛错，不静默返回 0 分", () => {
  const callIdx = EVAL.indexOf("parseQuickResult(content)");
  assert.ok(callIdx >= 0, "找不到 parseQuickResult 调用");
  const after = EVAL.slice(callIdx);
  const guardIdx = after.search(/if\s*\(\s*parsed\.score\s*<=\s*0\s*\)/);
  assert.ok(guardIdx >= 0, "缺少 score<=0 的兜底判断");
  const guardBlock = after.slice(guardIdx, after.indexOf("return parsed", guardIdx));
  assert.ok(
    /throw new Error\(/.test(guardBlock),
    "score<=0（0 不在 0.5~5 的打分刻度上，必是解析失败）必须抛错，不能把 0 分当成打分落地",
  );
});

test("分数解析容忍全角与『out of 5』写法", () => {
  assert.ok(
    /replace\(\/\[０-９\]\/g/.test(EVAL),
    "缺少全角数字归一：中文模型输出「２.５／５」时 score 正则整条落空",
  );
  assert.ok(/replace\(\/／\/g/.test(EVAL), "缺少全角斜杠归一");
  assert.ok(
    /out\\s\+of\\s\+5/.test(EVAL),
    "score 正则不认「2.5 out of 5」这类分母写法",
  );
});
