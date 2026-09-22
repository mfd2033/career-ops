# ADR-0049: 批量评估逐工具步骤实时透传（Claude worker stream-json + itemKey 事件 + 子台账 steps）

## 状态

Accepted (2026-09-22)

## 背景

批量评估（`/api/batch-evaluate`）当前用纯文本 argv 派发 worker，只嗅 `VERDICT:`/`ERROR:` 正则行。运行中前端只能看到「进度 [3/20]」与逐项终态结果，无法观察单个 worker 当前在调哪个工具（fetch 哪页 / 写哪个文件 / 跑哪条命令），卡死与正常推进不可区分（#17）。

单任务 `/api/run` 已有完整的 stream-json + `parseClaudeEvent` + 逐工具事件透传链路（ADR-0042 决议 2、ADR-0047 落盘），但批量路由因"需读纯文本提取 VERDICT 信封"刻意回避了该通路。

## 决策

1. **范围**：仅 `spec.id === "claude"` 时切 stream-args；非 Claude CLI 保持纯文本无步骤。#16（Qoder/CodeBuddy 解析器）落地后再扩。
2. **argv**：批量 worker 改用 `claudeCliArgs({kind:"evaluate", prompt})`（包含 `--output-format stream-json --include-partial-messages --verbose` + permission flags）。
3. **事件解析**：每 worker 的 stdout 按 JSONL 行缓冲，走 `parseClaudeEvent(line)` 得到 `{tool, detail?, text?, status?, error?}`。
4. **VERDICT/ERROR 抽取**：从 parsed `{text}` 事件累积文本后 regex 匹配（替代直接对 raw chunk 匹配）。
5. **事件透传**：在 batch 自身 NDJSON 流（POST 响应体）里新增：
   - `{type:"item-running", reportNum, url}` — worker spawn 后立即发，建立 reportNum→行映射。
   - `{type:"tool", itemKey: reportNum, name, detail?}` — 每个 tool 事件带 itemKey。
   - 旧客户端忽略未知事件类型（job-store line 205），零回归。
6. **itemKey 格式**：`reportNum`（数字），短且确定唯一。客户端凭 `item-running` 事件建立映射。
7. **partial messages**：保留 `--include-partial-messages`，工具开始时即报（不等 assistant 完成块），对"监督卡死"场景必需。
8. **事件粒度**：服务端全量透传，不做过滤/节流。客户端展示截断（最后 3–5 步）。
9. **降级开关**：无需。事件量可控（每 worker 20–50 tool 事件 × ≤10 并发 ≤ 500 事件）。
10. **渲染位置**：/jobs 列表批量行展开后，running item 下方内联显示最后 3–5 步；终态 item 折叠步骤。
11. **持久化**：item 结束时用 `buildRunLedgerSteps(collectedEvents)` 折叠步骤，传入 `buildBatchChildRecord` 的 `steps` 字段（受 `RUN_STEPS_CAP` 截断）。历史回看经子台账详情页 `/jobs/{childId}` 渲染。
12. **不改**：`/api/events` 总线、单任务 `/api/run`、`buildRunLedgerSteps` 本体。

## 后果

- 正面：批量运行中可实时观察每 worker 动作，判断是否卡死；子台账带步骤后历史可回溯执行细节。
- 代价：批量 route 的 worker stdout 处理逻辑从 4 行 regex 膨胀到 ~20 行 JSONL 缓冲 + parse + 分发；首次引入 Claude-only 条件分支。
- 后续：#16 落地后 Codex/Qoder 同理接入；#14（serverItems reset）在实现步骤渲染时一并修复。
