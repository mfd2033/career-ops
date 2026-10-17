// 快评超时预算回归测试（诊断「快评失败：This operation was aborted」）。
//
// Bug 链条：quick-eval.ts 的 quickEvaluate 对远程 AI 端点只有一个写死的
// 3000ms AbortController 超时。真实第三方端点（网络抖动 / 冷启动 / 把 ~4k 字
// 简历摘要 + 整段 JD 内联进 prompt 的生成时间）正常偏慢即 >3s → controller.abort()
// 触发 fetch 抛 DOMException（name=AbortError, message="This operation was
// aborted"）→ route.ts catch 原样 e.message 返回 502 → extension/background.js
// 用「快评失败：」前缀把裸英文报错直显给中文 UI。
//
// 锁死三条不变量，防止回归：
//   1. 服务端内部 LLM 超时不能是过紧的写死小值（≥10s，且用命名常量）。
//   2. AbortError 必须被翻译成可读中文，绝不让裸 "This operation was aborted" 漏出。
//   3. 超时预算层级：服务端内层 < 插件外层（内层先超时才能给出友好文案）。
//
// 说明：quick-eval.ts 是 TS 且顶层 import `@/lib/career-ops` 路径别名，
// node --test 无法直接 import 该模块（无构建/别名解析），故按本仓库既有约定
// （engine-config-guard / report-target 等同族）以源码文本守卫锁行为。
//
// Run:  node --test web/tests/lib/quick-eval-timeout.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVAL = readFileSync(join(ROOT, "web", "src", "lib", "quick-eval.ts"), "utf8");
const BG = readFileSync(join(ROOT, "extension", "background.js"), "utf8");

// 从源码里按正则抠出第一个捕获组并转成数字，命中不到返回 null。
function firstNumber(regex, text) {
  const m = text.match(regex);
  return m ? Number(m[1]) : null;
}

test("服务端内部 LLM 超时不是过紧的写死 3000ms，且已抽成命名常量", () => {
  // 旧的致病写法：setTimeout(() => controller.abort(), 3000)
  assert.ok(
    !/controller\.abort\(\),\s*3000\s*\)/.test(EVAL),
    "quick-eval.ts 又回到了写死 3000ms 的过紧超时——正常偏慢的 AI 端点必被 abort",
  );
  // abort() 计时必须引用命名常量而非裸数字
  const abortArg = EVAL.match(/controller\.abort\(\),\s*([A-Za-z0-9_]+|\d+)\s*\)/);
  assert.ok(abortArg, "找不到 controller.abort() 的超时计时");
  assert.ok(
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(abortArg[1]),
    `超时值应是命名常量（便于与插件外层预算对齐），实际为裸数字 ${abortArg[1]}`,
  );
  assert.ok(
    /const\s+QUICK_EVAL_TIMEOUT_MS\s*=\s*(\d+)/.test(EVAL),
    "缺少命名超时常量 QUICK_EVAL_TIMEOUT_MS",
  );
  const ms = Number(EVAL.match(/const\s+QUICK_EVAL_TIMEOUT_MS\s*=\s*(\d+)/)[1]);
  assert.ok(ms >= 10_000, `内部超时 ${ms}ms 过紧（下限 10s）`);
});

test("AbortError 被翻译成可读中文，裸 'This operation was aborted' 不会漏出", () => {
  assert.ok(
    /name\s*={2,3}\s*["']AbortError["']/.test(EVAL),
    "quick-eval.ts 没有识别 AbortError（超时）并单独处理——裸英文报错会直显给用户",
  );
  // 超时分支抛出的 message 不能是原始 e.message 透传
  const abortBranch = EVAL.slice(EVAL.search(/name\s*={2,3}\s*["']AbortError["']/));
  assert.ok(
    /throw new Error\(/.test(abortBranch.slice(0, 400)),
    "AbortError 分支必须抛出一个翻译后的友好 Error，而非 rethrow 原始 DOMException",
  );
});

test("超时预算层级：服务端内层 < 插件外层 fetch 超时", () => {
  const innerMs = Number(EVAL.match(/const\s+QUICK_EVAL_TIMEOUT_MS\s*=\s*(\d+)/)[1]);
  // 插件侧对 /api/quick-eval 的 AbortSignal.timeout：从 fetch 点向后取第一个超时值
  const at = BG.indexOf("/api/quick-eval");
  assert.ok(at >= 0, "background.js 找不到 /api/quick-eval 请求");
  const sigIdx = BG.indexOf("AbortSignal.timeout(", at);
  const outerMs = sigIdx >= 0 ? firstNumber(/AbortSignal\.timeout\(\s*(\d+)\s*\)/, BG.slice(sigIdx)) : null;
  assert.ok(innerMs > 0 && outerMs !== null, "两侧超时值都需可解析");
  assert.ok(
    outerMs > innerMs,
    `插件外层 ${outerMs}ms 必须大于服务端内层 ${innerMs}ms，否则外层先 abort、用户只看到笼统的「本地 web 服务/接口异常」`,
  );
});
