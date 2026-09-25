# ADR-0061: 工作器任务手动重试（error 卡原卡复用整卡重跑）

- **Status:** Accepted (2026-09-25)
- **Context:** 需求（2026-09-25，三轮 grilling 敲定）：/jobs 工作器任务失败后没有任何补救入口——SSE `error` → `finishJob("error")` 即终态，卡片只能被清除；想重跑只能回到原页面手动重新派发（批量还要重新勾选一遍）。现状与约束：

  1. **CLI 子进程内部已有自己的重试宣告机制**（`run-cli-support.mjs` 的 `RETRYING_STDERR_RE`，重试中的任务不被误判死亡）——web 层重试只应在终态失败后介入，不能与 CLI 内部重试叠加。
  2. **本地卡已存派发摘要但不存批量参数**：单任务卡的 `kind` + `input` 足以原样重发；批量卡只有 `items` 结论清单与 `batchId`，原始 `urls`/`ns` 只在 `startJob` 派发时传参、未落卡——整卡重跑无从取参。
  3. **取消无终态**：`cancelJob` 直接移除卡片，「仅 error 可重试」与之天然不冲突。
  4. **两类卡不可重试**：池源临时卡（`active-*`，扩展/其他 tab 经 `/api/active-runs` 浮现）与 ledger-only 行只有 url 摘要、无完整派发参数，前者不落 localStorage、后者只是台账投影。
  5. **先例**：explore 页「重试扫描」页内按钮；收件箱批量删除（ADR-0057）的二次确认弹窗；/jobs 列表行的展开 chevron 是「Link 兄弟节点按钮」的模式先例（按钮放 Link 外，不用 stopPropagation）。
  6. **web 组件无单测基建**（known gap，ADR-0057/0059/0060 同口径）：可判定逻辑抽 `web/src/lib/*.mjs` 纯函数 + `node --test`。

- **Scope:** web 层——`job-store.tsx`（Job 类型 + retryJob 派发路径）、/jobs 列表行与 `/jobs/[id]` 详情页的重试入口、i18n（jobs cluster，en+zh）、可判定逻辑纯函数 + 单测。**不动**：服务端 API（`/api/run`、`/api/batch-*`、`/api/active-runs` 零改动）、CLI 层重试机制（`RETRYING_STDERR_RE` 原样）、池源/扩展源卡片、ledger-only 行、自动重试策略（本期明确不做）。

## Decision

1. **仅手动重试**：`error` 终态卡提供「重试」按钮；不做自动重试/退避。CLI 内部重试已覆盖瞬时故障，web 层自动重试易与其叠加放大消耗。
2. **整卡重跑**：批量任务重试 = 整批重新派发，已成功项接受重复执行；按失败项重试留作二期（需动批量数据结构与对账逻辑）。
3. **原卡复用 + attempt 计数**：Job 新增 `attempt` 字段（缺省 = 1），重试时 +1，列表与详情展示「第 N 次尝试」；时间线追加「第 N 次尝试」分隔行后**保留旧步骤**（`STEPS_CAP` 滚动窗口自然截断更早的尝试，接受）；`items`/`batchPos`/`serverBatchId`/`text`/`result`/`runId`/`interruptedAt` 及时间戳字段清空重建，`startedAt` 重置。
4. **可重试范围**：仅本地卡（`job-*` id）且 `status === "error"`（含跨会话恢复的 `interruptedAt` 卡）；取消/完成不提供入口；池源卡与 ledger-only 行不可重试。
5. **引擎沿用卡片快照**：重试派发用卡上记录的 `cliId`/`model`（ADR-0043），缺失才回退重新解析——重试语义是「原样再来」，换引擎应改设置后新建任务。
6. **批量重试二次确认**：`urls`/`ns` 条数 > 1 的卡片重试前弹确认框（复用 ADR-0057 的内嵌弹窗模式，不用 `window.confirm`），明示整卡重跑与条数；单任务一键直达。
7. **双入口**：/jobs 历史列表错误行（重试按钮做 Link 的兄弟节点，沿用展开 chevron 的行外模式）+ `/jobs/[id]` 详情页头部；侧栏 tray 不加（只显示前 6 张、空间小，详情页一键可达）。
8. **派发路径复用**：store 新增 `retryJob(id)`，把 `startJob` 的派发体（单任务 POST `/api/run` / 批量 POST batch-* 端点 + 事件接线）抽成共享内部函数，`startJob`（新建卡）与 `retryJob`（复用卡）共同调用；服务端零改动。**批量派发参数 `urls`/`ns` 随卡片持久化**（Job 新增字段）——这是重试可行性的前提。
9. **次数不设上限**：手动重试由用户自主决策，每次失败后仍可再次重试。

## Alternatives considered

- **自动重试 N 次 + 退避**：与「用户盯着关键任务」的真实工作流相反，且与 CLI 内部重试叠加放大消耗；否决，自动策略留作远期（需先做失败分类）。
- **按失败项重试**：省 token，但要动批量数据结构、items 幂等合并与台账对账；二期候选，不混入本期。
- **新建卡片重试**：失败证据在 UI 完整保留，但列表易堆积、需维护新旧卡关联；原卡复用 + attempt 计数 + 台账留痕已覆盖排查需求。
- **重新读当前 CLI/模型设置**：同一卡两次尝试环境不一致，失败对比失真；「换引擎重试」应显式新建任务。
- **一律确认 / 一律直接**：批量误触代价高需确认，单任务加确认则繁琐；分级最合理。
- **重试入口放侧栏 tray**：tray 只显示前 6 张且卡片小；详情页一键可达，收益不抵布局成本。

## Consequences

- localStorage 卡片体积增加（`urls`/`ns` 数组随批量落卡）——批量条数受 API 上限约束、40 张卡上限不变，配额风险可控；`STEPS_CAP_PERSIST` 截断口径不变。
- 「重复消耗」变得可见：attempt 徽章让用户明确知道这是第几次尝试、成本在翻倍。
- 服务端无感知：重试即一次全新派发——台账里是两条独立记录（原失败 run + 重试 run），ADR-0034 的失败证据完整保留；`/co-job-done`、`/api/runs/save`、卡片-台账去重逻辑零改动（新 run 新 runId 落卡）。
- 中断卡（`interruptedAt`）重试后标记清除，跨会话恢复语义不受影响。

## References

- ADR-0020（事件通道与派发路径）、ADR-0031（卡片-台账对账）、ADR-0034（失败证据入账）、ADR-0042/0043/0044/0045（卡片字段口径）、ADR-0057（二次确认弹窗先例）。
- `web/src/components/jobs/job-store.tsx`、`web/src/components/jobs/worker-pills.tsx`、`web/src/app/jobs/page.tsx`、`web/src/app/jobs/[id]/page.tsx`、`web/src/lib/i18n/clusters/jobs.ts`、`web/src/lib/run-cli-support.mjs`。
- 实现工单：`.scratch/worker-job-retry/issues/01–04`（纯函数+持久化 → retryJob 派发路径 → UI 双入口 → 验证收尾）；单测 `web/tests/lib/job-retry.test.mjs`。
