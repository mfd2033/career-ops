# ADR-0052: 接入 Qoder CN（qoderclicn）为可派发运行时（独立 argv 构造 + 复用 Claude 事件解析 + 厂商目录探测 + 动态模型清单）

## 状态

Accepted (2026-09-23)

## 背景

web dashboard 的 `KNOWN` 有 8 个可派发运行时，其中只有 claude / codex 会解析结构化事件流；其余 6 个只能把 stdout 当纯文本，运行时看不到逐工具步骤（ADR-0042 决议 2、ADR-0047、ADR-0049）。#16 要求接入 Qoder / CodeBuddy 的 stream-json，让它们也能显示逐工具步骤。

**实测事实**（本机 Qoder CN v1.1.41、`protocol_version 1.3.0`、已登录、`Qwen3.8-Flash`；两条最小任务 + 空 `--config-dir` 的未登录对照）：

- `--output-format` 取值 `text|json|stream-json`；`--include-partial-messages` 存在于二进制但**不出现在 `--help`**，且强制要求同时给出 `--print` 与 `stream-json`；**不认 `--verbose`**（Claude 的 stream-json 反而要求它）。`--permission-mode` 取值为 `default|accept_edits|bypass_permissions|dont_ask|auto`（下划线，回显时归一成 `acceptEdits`），工具过滤 flag 是连字符拼写 `--allowed-tools` / `--disallowed-tools`。
- 输出为一行一条 JSONL：`system/init`、`assistant`（`content[].type=tool_use`，实测 `name:"Bash"` + 完整 `input.command`）、`stream_event`（`message_start` / `content_block_start`(tool_use) / `content_block_delta`(text|thinking|input_json) / `content_block_stop` / `message_delta` / `message_stop`）、`result` —— **逐行与 Claude 同形**，`parseClaudeEvent` 在 77 行真样本上逐行都能正确解析或安全返回 `null`。
- Qoder 特有且被现有解析器静默丢弃的行：`system/hook_started|hook_progress|hook_response`（用户级 SessionStart 钩子，实测每次会话 6 行）、`system/artifacts_update`、`assistant` 的 `thinking` 块、`user` 的 `tool_result` 行。
- **未登录**：任务走 `result.is_error:true` + `result:"Not logged in · Please run /login"`（现成的人话错误通道）；`--list-models` 则 stderr 报 `Not logged in. Run \`qoderclicn login\` to authenticate.`、stdout 为空。
- **不申报用量**：`result.usage` 全为 0、`total_cost_usd: 0`、`total_credits: 0`；真实额度消耗只出现在逐轮 `stream_event.message_delta.usage.credits`（官方以 Credits 计费）。
- 可执行文件在 `%USERPROFILE%\.qodersec\bin\`，既不在 PATH 也不在 npm global —— `findBin` 的两条通路都覆盖不到。
- 真正的致命错误不落在 stderr：实测 cwd 在仓库根时 stderr 会有 7 行 `Skill conflict:` 噪声，不匹配通用致命正则；未登录的判定来自 `result` 事件。

CodeBuddy 本机只有桌面端与配置目录，**没有 `cbc`/`codebuddy` 可执行文件**，行形状无法实测 → 本轮不接，拆成阻塞式待办。

## 决策

1. **范围**：只接 Qoder CN。`id: "qoder-cn"`、label `"Qoder (CN)"`、`bin: "qoderclicn"`、`url: "https://qoder.com.cn/"`。只接 CN 二进制（`qoderclicn.exe`），不接国际版 `qodercli.exe`。
2. **argv 归属**：新建 `web/src/lib/qoder-invocation.mjs`，导出 `qoderCliArgs({kind, prompt})` 与 `parseQoderEvent(line)`。Qoder 与 Claude 的参数面差异集中在这一处，不在路由里分支。
3. **argv 形状**：`-p --output-format stream-json --include-partial-messages <权限 flags> <prompt>`，**不带 `--verbose`**。`-p` 是无值布尔，prompt 走位置参数（实测可用）。
4. **权限域单一来源**：工具 allow/deny 复用 `claude-invocation.mjs` 的 `toolScopeFor(kind)`，这里只做 flag 拼写映射（`--permission-mode accept_edits`、`--allowed-tools` / `--disallowed-tools`）。`clis.ts` 顶部「不许任何 runtime 给自己超出被审计者的权限」的约束由此落到第二个引擎。
5. **权限守卫测试**：新增测试逐字断言 `qoderCliArgs` 在每个 kind 下携带的 allow/deny 与 `toolScopeFor(kind)` 的产物相等 —— 把约定变成不变式，接住「随手改了一份副本」这个漂移形态（与 #10 同源）。
6. **事件解析**：`parseQoderEvent` 是薄包装，逐行委托 `parseClaudeEvent`；**唯一差异**是屏蔽 `result` 分支的 `tokens` / `costUsd`（Qoder CN 不申报用量；沿用 `run-cli-support.mjs` 自己那句「Null over an empty object: nothing to report must not look like an event」的口径）。
7. **模型清单动态化**：新建 `web/src/lib/qoder-models.mjs`：`execFileSync(bin, ["--list-models"])` + 15s 超时 + 模块级 60s 缓存 + `resetQoderModelCache()`，并挂到 `detectClisCached({ refresh: true })`（与 opencode 完全同构；ADR-0015 的「手动重检必须真查」在两个引擎上是同一个意思）。
8. **清单解析**：写 Qoder 专属行解析（跳过首行表头 `MODEL`、trim、去重），label 用 CLI 原样给出的显示名。不复用 opencode 的 `parseModelsOutput`（那是「一行一个 provider/id」；混用会把两种格式的差异藏进一个外挂补丁）。
9. **拉取失败不兜底**：`--list-models` 失败（未登录 / 离线）即返回空清单，不维护静态兜底表（静态副本会腐烂，且未登录时本来也跑不了任务）。静态 `MODELS["qoder-cn"]` 仍**必须存在**（`clis-coverage.test.mjs` 的静态正则强制），写成 `{ flag: "--model", default: "", options: [] }`（仿 antigravity 的空默认先例），运行时被真实清单覆盖。
10. **探测目录**：`CliSpec` 加可选 `binDirs?: string[]`（`~` 展开），调用处 `findBin(spec.bin, [...searchDirs(), ...spec.binDirs])`；Qoder 填 `~/.qodersec/bin`。PATH 与通用搜目录仍优先（追加目录天然排在后面）。`searchDirs()` 里已有的 `%LOCALAPPDATA%\agy\bin` **不动**（本轮不重构探测层）。
11. **模型注入位置**：沿用 `withModelFlag`（`--model` 追加在 prompt 之后）。已实测 Qoder 位置无关地接受该写法。
12. **stderr 分类**：不加 Qoder 专属 `stderrIsFatal`，走通用正则。已核对：实测噪声（7 行 `Skill conflict:`）不匹配任何致命项，而未登录的判定走 `result` 事件而不是 stderr。
13. **用户级钩子**：不加 `--setting-sources`、不加 `--strict-mcp-config`。dashboard 只负责调用 CLI，不改它的用户配置 —— 与用户在终端跑 `qoderclicn` 的行为一致。
14. **批量不动**：`batch-evaluate` 继续 `isClaude` 分支，Qoder 在批量里走纯文本（与 ADR-0049 决议 5 一致）；batch 泛化另立待办。
15. **测试样本不入库**：实测原始样本含本机绝对路径与技能清单，只按 `run-cli-support.test.mjs` 的既有风格提炼手写最小行，并补上真样本出现过、现有测试未覆盖的形状（`hook_*`、`thinking`、`tool_result`、`artifacts_update`）。
16. **未登录的可读性**：配置页在模型下拉为空时补一句「未能列出模型（可能未登录或离线）」—— 补上「失败即空清单」留下的沟通缺口。
17. **文档**：`docs/SUPPORTED_CLIS.md` 增一行（Headless 列写实测过的调用；Entry File 列未实测则写 `—`，不编造）+ `cli-labels.mjs` 增标签 + 一条变更记录 + `CONTEXT.md` 补术语（厂商安装目录 / 动态模型清单 / 用量申报）。
18. **验证口径**：单测 + typecheck + dev 真跑一次 + **重新打包后再真跑一次**（对齐 ADR-0047 / ADR-0049 的收口口径）。

## 考虑过的方案

- **完全复用 `parseClaudeEvent`（一行不改）**：Qoder CN 的 `result.usage` 全 0、`total_cost_usd` 为 0，界面会显示「0 token · $0.00」，等于宣称这次没花任何东西，而它烧的是 credits。被否。
- **扩展 `ParsedEvent` 加 `credits` 并在 UI 显示额度消耗**：parser + 路由 + 前端三层改动，是一个独立功能，不属于 #16。被否（可另立）。
- **静态抄写实测的 14 个模型**：`--list-models` 才是权威且随 CLI 版本变，静态表会腐烂。被否。
- **把 Qoder 当 claude 的特例、在 `/api/run` 路由内分支拼 argv**：权限策略被埋进路由更难审计，且让工具域出现第二份副本（正是 #10 要防的漂移）。被否。
- **`--setting-sources project,local` 屏蔽用户级钩子**：更可预测，但与用户终端行为不一致，且会关掉 Qoder Security 的会话扫描。被否。
- **顺手把 `searchDirs()` 里的 `agy` 迁进 `binDirs`**：本轮目标是接引擎而非重构探测层，且会被迫重新验证已有的 antigravity 探测。被否。

## 后果

- 正面：Qoder CN 成为第 3 个有逐工具步骤的运行时；权限域仍是单一来源并被测试锁住；模型下拉跟 CLI 的真实清单走，不写静态副本。
- 已知缺口（明示，非缺陷）：run 结束不显示用量（Qoder CN 只报 credits）；每次运行会执行用户的 Qoder SessionStart 钩子（含 Qoder Security）；批量评估里 Qoder 仍无步骤；`--list-models` 需登录，未登录时下拉为空（有文案提示）。
- 后续：CodeBuddy 接入拆成阻塞式待办（前件：本机装 `cbc`/`codebuddy` 并实测行形状）；batch 泛化（`isClaude` → `spec.streamArgs + spec.parseEvent`）另立待办。
