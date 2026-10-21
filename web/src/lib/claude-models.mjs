import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Claude 引擎的「真实模型列表」，读自本机实时生效的 `~/.claude/settings.json`。
//
// 为什么读这个文件而不是别处：
//   - Claude Code CLI 没有 `--list-models`，无法像 opencode / qoder 那样问 CLI 本身。
//   - 本地代理（cc-switch）的 `/v1/models` 返回空目录，不暴露可选项。
//   - 真正决定「这次 `--model` 会落到哪个模型」的，就是这个文件里 `env` 段的
//     `ANTHROPIC_DEFAULT_*_MODEL` 档位映射（以及显式覆盖 `ANTHROPIC_MODEL`）——
//     它由 cc-switch 在切换 provider 时写出，是 CLI 实际读取的唯一事实源。
//
// 因此这里不猜、不抄静态副本，只把当前档位映射解析出来。解析不到（官方直连、
// 无代理、文件缺失/损坏）时返回空数组，交给 `detectClis` 回退到静态表，
// 与 opencode / qoder 的「问不到就留空、不编造清单」同一纪律（ADR-0052/0053）。

// 采集顺序：显式覆盖 ANTHROPIC_MODEL 排最前（它就是「现在实际在用的那个」），
// 再按 opus → sonnet → haiku → fable 四个档位取默认映射。
const MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
];

/**
 * 从 settings.json 的原始文本解析出真实模型清单（纯函数，便于单测）。
 *
 * id === label === 解析后的模型 id：派发时原样拼进 `--model`，与静态表里
 * `claude-opus-5` 这类原始 id 选项的行为一致，代理据此再映射到上游真实模型。
 * 同一模型被多个档位指向时按 id 去重，保留首次出现的顺序。
 *
 * @param {string | null | undefined} raw - settings.json 文件内容
 * @returns {{id: string, label: string}[]} 解析不到任何模型时为空数组
 */
export function parseClaudeSettings(raw) {
  if (!raw) return [];
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return []; // 损坏的 JSON：不猜，交给调用方回退静态表
  }
  const env = cfg && typeof cfg === "object" ? cfg.env : null;
  if (!env || typeof env !== "object") return [];
  const seen = new Set();
  const models = [];
  for (const key of MODEL_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
}

/**
 * 读取本机 `~/.claude/settings.json` 并解析出真实模型清单。
 *
 * 不额外做进程内 TTL 缓存：文件读取极廉价，而整份 `detectClis()` 结果本就被
 * 进程内缓存，只有配置页「重新检测」(refresh=1) 才会重跑并重新读文件——正好
 * 满足「切了 provider 想立刻看到新列表」的语义。
 *
 * @param {string} [settingsPath] - 覆盖默认路径（仅供测试注入）
 * @returns {{id: string, label: string}[]} 文件缺失/不可读/无映射时为空数组
 */
export function loadClaudeModels(settingsPath) {
  const fp = settingsPath || path.join(os.homedir(), ".claude", "settings.json");
  let raw;
  try {
    raw = fs.readFileSync(fp, "utf-8");
  } catch {
    return []; // 没有这个文件（官方直连等）→ 回退静态表
  }
  return parseClaudeSettings(raw);
}
