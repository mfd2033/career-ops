# ADR-0030: checkup worker 纳入诚实门禁——台账产物校验 + 门禁抽缝

- **Status:** Accepted (2026-09-16)
- **Context:** 2026-09-16 三次体检实测暴露：#73/#131 两个 kind=checkup worker 被上游（本地代理 → agnes-2.5-flash）以「步骤过多已自动中止」掐断，`claude -p` 视其为正常收尾退出 0，`/api/run` 的诚实门禁把两次**零产物**运行记成 `done`（`data/company-checkups.tsv` 无行、`reports/checkups/` 无文件、评估报告无附录）。根因是门禁的产物校验只覆盖 `evaluate`：`const persists = kind === "evaluate"`。这与 ADR-0027「工作器失败的排查路径与 evaluate 相同」的承诺相悖，也与 cc10653 修复的批量评估「全失败仍记 done」同类。连带伤害：派发时已写入 `[x]` 审计行，同天去重把按钮重试也挡在 409，两条路全堵。
- **Scope:** 只改诚实门禁；上游中止本身是环境问题（本地代理的步数上限），不在本仓库修。

## Decision

1. **checkup 的产物信号 = `data/company-checkups.tsv` 新增行**。台账是体检数据的唯一机器通道（ADR-0025），HTML 只是可选附件（`--html -` 合法），所以门禁必须锁台账行而非 HTML 文件。行计数与 `lib/log-checkup.mjs`（schema 单一来源，tests/checkup-ledger.test.mjs 锁定）解耦：门禁只需要「行数是否增加」，容忍截断行，不重述 schema。
2. **门禁抽缝。** route.ts 的诚实门禁（无输出 / 未落盘 / 非正常退出）是闭包内联的，没有可断言的测试缝——这正是 checkup 长期漏网的原因。整体抽成 `run-cli-support.mjs` 的纯函数 `persistRunOutcome()`，与 `pdfRunOutcome` 同构；route.ts 只做快照与调用。evaluate 用 `hasNewCompletedReport(reports/ 增量)`，checkup 用台账行增量，通过 `persisted` 参数注入，门禁本身不碰文件系统。
3. **门禁覆盖种类单点声明。** `PERSISTENCE_GATED_KINDS = { evaluate, checkup }`（fix-portal 是配置修复、产物为 portals.yml，本次不扩；保持现状并在此记录缺口）。
4. **失败文案区分两类缺口**：evaluate「没存报告」与 checkup「没写台账」各自点名自己的通道，避免把 checkup 的失败说成 tracker 缺报告。

## Consequences

- 「道歉式中止」的 worker 从此以 error 终态入账本（`.career-ops-web/runs/index.jsonl`），/jobs 如实显示失败，不再污染「已完成」。
- 门禁对 `evaluate` 的既有行为逐分支保持不变（迁移即等价，由回归测试锁定）。
- `tests/run-persistence-gate.test.mjs` 锁定门禁全部分支与台账行计数；它同时是 2026-09-16 #73/#131 假 done 的回归测试。
- 上游步数上限（#124 约 22 次工具调用过关，#73 42 次、#131 49 次被掐）仍需在环境侧解决；本 ADR 只保证这类失败**可见**。
