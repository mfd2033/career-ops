// Claude 真实模型清单解析：读实时 `~/.claude/settings.json` 的档位映射。
//
// 钉的是这个功能的全部判断：按 opus→sonnet→haiku→fable（含显式 ANTHROPIC_MODEL）
// 取值、按 id 去重、非字符串/空值过滤，以及「解析不到就返回空让 detectClis 回退
// 静态表」——绝不编造一份可能已失效的清单（与 opencode/qoder 同一纪律）。
//
// Run:  node --test web/tests/lib/claude-models.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseClaudeSettings, loadClaudeModels } from "../../src/lib/claude-models.mjs";

test("parseClaudeSettings: 按档位顺序取映射，id 与 label 都是真实模型 id", () => {
  const raw = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5",
    },
  });
  assert.deepEqual(parseClaudeSettings(raw), [
    { id: "claude-opus-5", label: "claude-opus-5" },
    { id: "claude-sonnet-5", label: "claude-sonnet-5" },
    { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
    { id: "claude-fable-5", label: "claude-fable-5" },
  ]);
});

test("parseClaudeSettings: 显式 ANTHROPIC_MODEL 排最前", () => {
  const raw = JSON.stringify({
    env: { ANTHROPIC_MODEL: "qwen3:4b", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" },
  });
  assert.deepEqual(parseClaudeSettings(raw).map((m) => m.id), ["qwen3:4b", "claude-sonnet-5"]);
});

test("parseClaudeSettings: 多档位指向同一模型时按 id 去重", () => {
  const raw = JSON.stringify({
    env: {
      ANTHROPIC_MODEL: "qwen3:4b",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3:4b",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3:4b",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3:4b",
    },
  });
  assert.deepEqual(parseClaudeSettings(raw), [{ id: "qwen3:4b", label: "qwen3:4b" }]);
});

test("parseClaudeSettings: 非字符串与空值一律过滤", () => {
  const raw = JSON.stringify({
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "", ANTHROPIC_DEFAULT_SONNET_MODEL: "  ", ANTHROPIC_DEFAULT_HAIKU_MODEL: 42 },
  });
  assert.deepEqual(parseClaudeSettings(raw), []);
});

test("parseClaudeSettings: 无 env / 坏 JSON / 空输入都返回空数组（回退静态表）", () => {
  assert.deepEqual(parseClaudeSettings(JSON.stringify({ effortLevel: "high" })), []);
  assert.deepEqual(parseClaudeSettings("{ not json"), []);
  assert.deepEqual(parseClaudeSettings(""), []);
  assert.deepEqual(parseClaudeSettings(null), []);
  assert.deepEqual(parseClaudeSettings(undefined), []);
});

test("loadClaudeModels: 文件不存在时返回空数组，不抛", () => {
  const missing = path.join(os.tmpdir(), `no-such-claude-settings-${Date.now()}.json`);
  assert.deepEqual(loadClaudeModels(missing), []);
});

test("loadClaudeModels: 从注入路径读出真实映射", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-"));
  const fp = path.join(dir, "settings.json");
  try {
    fs.writeFileSync(fp, JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5" } }), "utf-8");
    assert.deepEqual(loadClaudeModels(fp), [{ id: "claude-sonnet-5", label: "claude-sonnet-5" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
