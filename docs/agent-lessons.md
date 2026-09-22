# 工程经验沉淀（agent lessons）

> 索引在 `modes/_custom.md`「工程经验沉淀」。按需 Read 对应小节，不要全文展开。内容已脱敏（真实公司名/数字泛化）。§ 编号沿用迁入时的记忆条目编号。

## §2 Web 工作器两类 run 的事件模型

- **单条 run**（/api/run，kind=evaluate/checkup/pdf）：claude/codex 有 `spec.parseEvent`（stream-json → `{tool,status,text}` 事件 → run-events 总线 → /api/events）；ADR-0047 终态时把缓冲区折叠成 steps 写入 run 台账（`.career-ops-web/runs/index.jsonl`），详情页据此重建逐工具时间线。其余 CLI（opencode/gemini/copilot/qwen/antigravity/grok）只发 text，永不产 tool 事件。
- **批量 run**（/api/batch-evaluate、/api/batch-checkup）：纯文本 argv，不产逐工具事件；走独立 NDJSON 响应流；台账落逐项 items（非 steps）。批量详情页没有逐工具步骤——设计如此，非 bug。
- **排查**：「没步骤」先看 /api/active-runs 的 source（batch|run）；batch 探 /api/events 得 0 帧属正常。

## §3 验证短命服务端状态派生的 UI：桩重放，不跑真实任务

1. 两端证据分开固定：只读请求抓目标端点**真实响应体** + 单测断言格式化规则。
2. 页内注入 `window.fetch` 桩，只拦截目标端点返回真实响应体，其余透传 `orig.apply(this, arguments)`。
3. 注入后不刷新（刷新清桩），等一个轮询周期，DOM 文本 + 属性 + 截图取证。
4. 报告必须声明数据来自桩并附注入 JSON，不得表述成实时任务。

理由：真实短命任务与子代理启动延迟赛跑必输（首采样数分钟 vs 任务秒级结束/采样前跑完），且真任务产生副作用数据；桩零成本、可重复、只影响该标签页。

## §5 Windows execFile 管道继承使 timeout 失效

- **根因**：孙进程继承 stdio 管道 → 'close'（exit + 全部 EOF）永不到达，promisify(execFile) 永不 resolve；有字节在途时 'exit' 本身也被拖到孙进程 EOF（Node 22 实测）。
- **修复**：`spawn` 自建 runner，kill timer 为唯一硬界；超时即 kill 并用已缓冲输出 settle（有字节 resolve、纯静默 reject）；正常路径 exit+grace(250ms)；settle 时 destroy stdout/stderr。参考 `bsk-extract.mjs` 的 `execWithHardTimeout`，回归锁 `tests/bsk-extract.test.mjs` S11。
- **排查顺位**：「无限卡住但名义有超时」→ 管道继承 > 网络无超时；用日志最后一条已批准 tool call 定位卡点。批量体检失败 stderr 已随 job-*.md 落盘（batch-checkup 路由 stderrTail）。/api/run/cancel 只认 run-events 的 runId（uuid），不认 active-runs 的 pool-N。

## §6 含中文的 .ps1 需 UTF-8 BOM 或纯 ASCII（PowerShell 5.1）

无 BOM 按 ANSI/GBK 解码，中文吞掉字符串终止符 → ParserError。二选一：(a) 正文全 ASCII，中文/PUA 匹配用码点区间 `[\uE000-\uF8FF]`；(b) 存 UTF-8 with BOM。非法文件名枚举用 `Where-Object { $_.Name -match ... }` + `-LiteralPath`；改名/删除脚本必须带「命中数≠预期即 abort」闸门。

## §7 跨源合并去重键：两侧施加同一归一化

一源写入时对字段做过截断/归一化（如 `clipStepLabel(...,200)`），去重键必须对两侧套同一函数（复用导出的 `clipStepLabel`），否则长值漏去重、重复露两行；勿用两侧必然不同的字段（客户端 ts vs 服务端墙钟 ts）当去重身份。案例：ADR-0047 治愈卡 steps 双行，修复在 `mergeHealedSteps`。

## §8 评估报告字段级事实必须可溯源

- 公司名/薪资/URL 写入前必须能溯源到**当次抓取证据**；不可溯源 → 留空或显式 `unknown`/`confidential`/问用户。
- 绝不从 cv.md 雇主、相邻报告数字或臆测填充（历史案例：某报告 JD 抓取不全时现任雇主被误填为 posting 公司、薪资从相邻报告串行复制，已脱敏）。
- 报告头 `Verification` 行必须与事实一致；写入后可重访原 URL 核验。

## §9 ADR-0045 批量历史逐项展开（实现快照）

批量 run 终态落台账（serverBatchId 为 id、items 快照 cap 100，`web/src/lib/batch-ledger.mjs`）；`ledger-merge.mjs` 去重合并；`batch-summary.mjs` 折叠摘要；`BatchItemList` 组件 + chevron 展开；运行中 3s 轮询 `GET /api/batch-items`；详情页 ledger-only items。遗留：serverItems 未随 serverBatchId 变化重置（路径不可达，待办 #14）。
