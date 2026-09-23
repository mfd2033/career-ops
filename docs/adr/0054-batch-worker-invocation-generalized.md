# ADR-0054: 批量 worker 调用泛化——isClaude 硬编码退役，spec 声明驱动（与 /api/run 同一选择式）

## 状态

Accepted (2026-09-23)

## 背景

ADR-0049 决议 1 把批量评估的 stream-json 通路限定在 `spec.id === "claude"`，其余引擎保持纯文本：批量路由里因此长出两处硬编码——argv 选择（`isClaude ? claudeCliArgs(...) : spec.args(prompt)`，route 自行 import `claudeCliArgs`）与 stdout 分支（`if (isClaude)`）。当时 Qoder/CodeBuddy 还没有解析器；如今 ADR-0052/0053 落地，`CliSpec` 已有完整的能力声明（`streamArgsFor`/`streamArgs` + `parseEvent`，claude/codex/qoder-cn/codebuddy 四家），批量路由的引擎分支成了第二个副本——而「同一策略写两份，其中一份漂了」正是 2026-09-15 权限 bug 的结构性教训（#10 的守卫诉求）。

单任务 `/api/run` 早已泛化：`spec.streamArgsFor ? … : (spec.streamArgs ?? spec.args)(prompt)`（route.ts 307 行），解析按 `spec.parseEvent` 门控。批量应对齐到同一选择式。

## 决策

1. **能力门控**：批量 worker 的 argv 与 stdout 解析由 spec 声明驱动，不再看 `spec.id`。选择式与 `/api/run` 逐字相同：`streamArgsFor > streamArgs > args`；`structured = typeof spec.parseEvent === "function"`。structured 为真走 JSONL 缓冲 + `spec.parseEvent`，否则维持纯文本 regex 嗅探。
2. **共享助手**：新增 `web/src/lib/worker-invocation.mjs` 的 `resolveWorkerInvocation(spec, { kind, prompt }) → { args, structured }`，`/api/run` 与 `/api/batch-evaluate` 都改从它取 argv。两通路不再各自维护选择式（#10 教训的结构性收口）；批量路由同时删除 `claudeCliArgs` import，路由层不再自拼任何引擎 flag。
3. **kind 恒为 `"evaluate"`**：批量只有评估一种 worker（checkup 走单任务通路），per-kind 权限 flag 由各引擎自己的 builder（`claudeCliArgs`/`qoderCliArgs`/`codebuddyCliArgs`）给出，权限模型仍是每个引擎一份、经审计的那份，路由不增不减。
4. **行为变化（接受并需真跑验证）**：
   - **codex**：批量从纯文本升为 `codexStreamArgs`（`exec --json --color never`）。`parseCodexEvent` 在 agent_message 吐 `{text}`（VERDICT/ERROR 抽取语义不变，仍是累积文本取最后匹配）、command_execution/web_search/mcp_tool_call 吐 `{tool}`（批量首次有逐工具步骤）。tokens/费用在批量仍不采集（`collectedEvents` 只收 tool 事件，现状）。
   - **qoder-cn / codebuddy**：批量 argv 从裸 `-p prompt` 升为各自 `streamArgsFor({kind:"evaluate"})`——即 `/api/run` 单评估已真跑验证过的同一 argv（含审计过的权限 flag）。Qoder 不申报用量、CodeBuddy 无 cost 的口径不变（批量本就不采）。
   - **claude**：`streamArgsFor({kind:"evaluate", prompt})` 与原 `claudeCliArgs({kind:"evaluate", prompt})` 逐字节相同，零变化。
   - **opencode/gemini/copilot/qwen/antigravity/grok**：无 `parseEvent`，走原纯文本路径，零变化。
5. **item 映射不新增**：`item-running`（reportNum→行）与 `tool`（itemKey 路由）事件在 ADR-0049 即为引擎无关，spawn 后宣告、逐事件透传、`buildRunLedgerSteps` 折叠进子台账——四家结构化引擎直接复用，事件 schema 与持久化零改动。
6. **守卫**：`tests/lib/batch-stream-events.test.mjs` 增加源码断言——批量路由不得 import `claudeCliArgs`/`codexStreamArgs`/`qoderCliArgs`/`codebuddyCliArgs`，必须经 `resolveWorkerInvocation` 取 worker argv（#10 的「路由不得自拼工具 flag」在批量侧落地）。
7. **不改**：`/api/events` 总线、事件 schema、子台账结构、VERDICT/ERROR regex 语义、并发池与 reservation 机制。

## 后果

- 正面：四家结构化引擎的批量与单任务行为同构（同一 argv builder、同一解析器、同一事件链），新引擎接入批量只需在 `KNOWN` 声明能力，路由零改动；选择式单份化消除双写漂移面。
- 代价：批量路由 stdout 分支的字面 `isClaude` 没了，可读性依赖 `structured` 命名与注释；codex/qoder/codebuddy 的批量真跑验证仍欠（单评估通路已验证过同一 argv，风险主要在多 worker 并发下的引擎稳定性，属引擎侧而非接线侧）。
- 回滚：单点 revert 批量路由 + 助手即可，事件 schema 未动，客户端零感知。
