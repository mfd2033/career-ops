// ADR-0073 的归属判定：模型 id 到底属于哪家引擎。
//
// 钉的是 2026-10-08 那次真实失败：账本引擎是 `claude + hy3`，`hy3` 只存在于 CodeBuddy
// 的目录里，`claude --model hy3` 报 `[claude-code:unrecognized_model]`。守卫必须在
// 「明确属于别家」时丢弃，在「两边都不认识」时保留 —— 后者是 opencode / qoder-cn 那
// 两张运行时才读的目录（ADR-0052/0053）不被误杀的唯一保证。
//
// Run:  node --test web/tests/lib/model-ownership.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { dropForeignModel, modelBelongsToOtherCli, reconcileEnginePick } from "../../src/lib/model-ownership.mjs";

// 与 clis.ts 静态表同形的最小目录：claude 目录里没有 hy3，codebuddy 里有。
const CATALOG = {
  claude: ["opus", "sonnet", "haiku", "claude-sonnet-5"],
  codex: ["gpt-5.4", "gpt-5.4-mini"],
  // glm-5.3 在两家目录里都可能出现（CodeBuddy 的目录就含各厂商 slug）—— 它是有目录引擎
  // 与无目录引擎之间唯一会误判的形状，下面第三档断言就钉这件事。
  codebuddy: ["cmcc:auto", "hy3", "hy3-x", "glm-5.3", "custom-local:agnes-2.5-flash"],
  // 动态目录引擎在静态表里就是空的（qoder-cn 决议 9）—— 守卫必须认这个形状。
  "qoder-cn": [],
};

test("modelBelongsToOtherCli: own catalogue wins even when another engine lists it", () => {
  assert.equal(modelBelongsToOtherCli("hy3", ["hy3"], ["hy3", "sonnet"]), false);
});

test("modelBelongsToOtherCli: absent here but present there is a dirty pair", () => {
  assert.equal(modelBelongsToOtherCli("hy3", CATALOG.claude, [...CATALOG.codebuddy, ...CATALOG.codex]), true);
});

test("modelBelongsToOtherCli: an id nobody lists is preserved, not guessed away", () => {
  // Given: 用户在 opencode 上选了个静态表看不见的模型（动态目录、lmstudio/ 自填）
  assert.equal(modelBelongsToOtherCli("lmstudio/qwen3", ["anthropic/claude-sonnet-4-5"], ["hy3", "gpt-5.4"]), false);
});

test("modelBelongsToOtherCli: an empty model is never 'foreign'", () => {
  assert.equal(modelBelongsToOtherCli("", CATALOG.claude, CATALOG.codebuddy), false);
});

test("dropForeignModel: the real incident — claude + hy3 is dropped", () => {
  assert.equal(dropForeignModel(CATALOG, "claude", "hy3"), "");
});

test("dropForeignModel: the same model on its own engine is kept", () => {
  assert.equal(dropForeignModel(CATALOG, "codebuddy", "hy3"), "hy3");
  assert.equal(dropForeignModel(CATALOG, "claude", "sonnet"), "sonnet");
});

test("dropForeignModel: an engine with no catalogue of its own is never judged", () => {
  // qoder-cn 的目录读自 CLI 本身：own 为空 = 无从判定，哪怕别家静态表里真有这个 id 也不丢
  // （误丢会把用户选的模型静静换成引擎默认，比漏过一个脏模型更难发现）
  assert.equal(dropForeignModel(CATALOG, "qoder-cn", "glm-5.3"), "glm-5.3");
  assert.equal(dropForeignModel(CATALOG, "qoder-cn", "glm-not-in-any-table"), "glm-not-in-any-table");
  // 目标引擎不在目录里（配置写错 id）同理：没有 own 可参考就不动
  assert.equal(dropForeignModel(CATALOG, "unknown-cli", "hy3"), "hy3");
});

test("dropForeignModel: unknown ids and an empty catalog never crash", () => {
  assert.equal(dropForeignModel(CATALOG, "claude", ""), "");
  assert.equal(dropForeignModel(CATALOG, "claude", undefined), "");
  assert.equal(dropForeignModel(null, "claude", "sonnet"), "sonnet");
  // 空目录 + 有目录的两档都不认这个 id → 保留（用户自填的自定义 slug）
  assert.equal(dropForeignModel(CATALOG, "claude", "lmstudio/local-model"), "lmstudio/local-model");
});

test("reconcileEnginePick: switching to a CLI that cannot run the saved model clears it", () => {
  const clis = [
    { id: "claude", model: { options: CATALOG.claude.map((id) => ({ id, label: id })) } },
    { id: "codebuddy", model: { options: CATALOG.codebuddy.map((id) => ({ id, label: id })) } },
  ];
  const r = reconcileEnginePick({ cliId: "claude", model: "hy3", modelCliId: "codebuddy", clis });
  assert.deepEqual(r, { model: "", modelCliId: "", dropped: true });
});

test("reconcileEnginePick: a model the new CLI does know keeps modelCliId untouched", () => {
  const clis = [
    { id: "claude", model: { options: CATALOG.claude.map((id) => ({ id, label: id })) } },
    { id: "codebuddy", model: { options: CATALOG.codebuddy.map((id) => ({ id, label: id })) } },
  ];
  const r = reconcileEnginePick({ cliId: "codebuddy", model: "hy3", modelCliId: "codebuddy", clis });
  assert.deepEqual(r, { model: "hy3", modelCliId: "codebuddy", dropped: false });
});

test("reconcileEnginePick: an id neither catalogue lists survives (legacy / dynamic)", () => {
  const r = reconcileEnginePick({ cliId: "claude", model: "agnes-2.5-flash", modelCliId: "", clis: [] });
  assert.deepEqual(r, { model: "agnes-2.5-flash", modelCliId: "", dropped: false });
});

test("reconcileEnginePick: no catalogue row for the target CLI means no evidence, so nothing is dropped", () => {
  // 派发路径永远从同一份检测列表里选出目标，所以“没这一行”只在异常形状下出现；
  // 那时保守地不动用户模型，不拿“别家有”当证据。
  const clis = [{ id: "codebuddy", model: { options: CATALOG.codebuddy.map((id) => ({ id, label: id })) } }];
  assert.equal(reconcileEnginePick({ cliId: "claude", model: "hy3", clis }).dropped, false);
});
