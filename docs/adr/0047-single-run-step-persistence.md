# ADR-0047: 单任务实时步骤流服务端持久化（台账内嵌 steps + 治愈/回读重建时间线）

- **Status:** Accepted (2026-09-21)
- **Context:** 工作器详情页 `/jobs/[id]` 的步骤时间线（`<ol>`）由 `job.steps` 驱动，而 `job.steps` 是**客户端 ephemeral 状态**：单任务（evaluate / pdf / 单条 checkup）的逐工具事件（`type:"tool"`）只流过两处易失内存——进程内 run-events 总线缓冲区（`run-events.ts`，`MAX_RECORDED_RUNS=50`、重启即清）与持有 `/api/events` 连接的那个页签的 localStorage 卡片。服务端 run ledger（`run-ledger.mjs` 的 `index.jsonl`）由 `recordEnd` 落盘，但**只写 `status/时长/原因`，不写步骤流**。后果：任务跑时页签不在线（刷新/切走/关闭），事后回看只能拿到派发种子步骤「正在启动…」+ 治愈补的终态「Done」两行，中间逐工具步骤永久无法重建。批量任务不受此限——ADR-0045 已把逐项快照 `items` 内嵌台账，ledger-only 视图能回读。约束与事实：
  1. `recordEnd` 在 `publish(done/error)` 之后调用（run 路由 `send()` 内），此刻该 run 的缓冲区仍持有全部事件（`completeRun` 之后缓冲区也保留），折叠步骤的数据源就地可用。
  2. 缓冲区事件此前不带墙钟时间戳（`ts` 由客户端收到时补），折叠出的历史步骤需要真实时间才能与 live 卡口径一致。
  3. 逐工具 detail 合并规则（一次工具调用一行、同名行就地并入 detail）已在客户端确立（ADR-0042 决议 2），服务端折叠须复用同语义，否则回读时间线与实时时间线长相不同。
  4. 截图症状（体检卡只剩两行）走的是**本地卡被 reconcile 治愈**路径（卡有 `runId`），不是 ledger-only 路径——两处读回端都要覆盖。
- **Scope:** `web/src/lib/run-steps.mjs`（新，事件→步骤折叠纯函数）、`web/src/lib/core/run-events.ts`（`publish` 打服务端 `ts`）、`web/src/app/api/run/route.ts`（`recordEnd` 内嵌 `steps`）、`web/src/lib/job-ledger-reconcile.mjs`（治愈时用 `rec.steps` 重建）、`web/src/components/jobs/step-timeline.tsx`（新，共享 `<ol>` 渲染）、`web/src/app/jobs/[id]/page.tsx`（类型 + ledger-only 接入 + live 视图改用共享组件）、`web/src/app/jobs/page.tsx`（类型对齐）、i18n（复用既有 key）、测试。**不改动**：run-events 总线内存语义与保留策略、`/api/runs/history` 读取逻辑（透传天然带出新字段）、`/api/runs/save` 的 CLI 可读 markdown（另一消费方，UI 不回读）、批量台账形状。

## Decision

1. **持久性 = 服务端落盘、内嵌主台账**：单 run 终结（done / error）时把步骤流折叠进 `index.jsonl` 该行的 `steps` 字段，与批量 `items` 同层同惯例（ADR-0045 决议 6）。不另立登记表 + 新 GET 端点——那与 run-events 缓冲区功能重复且同样重启即清，不满足「历史回看」这一核心诉求。
2. **折叠口径 = 复用客户端归则**：`run-steps.mjs` 只取 `type:"tool"` 与 `type:"status"`，**排除 `phase:` 前缀状态**（阶段不入步骤流，ADR-0042 决议 1）；同名工具行就地并入 detail（一次工具调用一行）；`label` 截断上限防台账行膨胀；取最近 `cap=20` 条（与 `STEPS_CAP_PERSIST` 同口径）。
3. **时间戳 = 服务端墙钟**：`publish()` 给每个事件打 `ts: Date.now()`，折叠出的历史步骤带真实时间。对现有回放无副作用（客户端本就用自己的 `Date.now()` 覆盖）。
4. **读回双通道**：
   - **ledger-only 详情视图**（`!job && ledgerEntry`）：`e.steps` 存在则渲染步骤时间线，「诚实子集」注释升级为「含重建的步骤流」。
   - **本地卡被治愈**（截图症状）：`reconcileJobsWithLedger` 若 `rec.steps` 存在，用台账 durable 步骤按 `label+ts` 去重合并进卡片，替换「只 append Done」；旧记录无 `steps` 时回落现行为。
5. **渲染单点**：live 详情页 `<ol>` 与 ledger-only 视图共用新 `StepTimeline` 组件，避免第三份 inline 重复（沿 ADR-0045 `BatchItemList` 共享渲染惯例）。
6. **向后兼容 = tolerant reader、无迁移**：功能前的旧台账行无 `steps`，读取端按「无步骤流」处理、不回填不伪造（沿 ADR-0043 缺失惯例）；无版本门禁。
7. **范围 = 单次 `/api/run` 的三个 kind**（evaluate / pdf / checkup），批量已在 ADR-0045 覆盖，扫描等伪批量不在本次。

## Alternatives considered

- **另立 `run-steps` 进程内登记表 + `GET /api/steps` 轮询**（照搬 batch-items 恢复通道）：与 run-events 缓冲区功能重复，且重启即清，覆盖不了「事后回看 / 换浏览器」的主诉求。否。
- **复用 `/api/runs/save` 的 `{id}.md` markdown**（已含步骤）：只在页签在线时由客户端写、且 UI 从不回读（供 CLI 读），数据源不可靠、不覆盖跨页签/重启。否。
- **边跑边实时 append 步骤到磁盘**：crash 也不丢已完成段，但双写者（内存缓冲 + 磁盘）一致性成本高，与 ADR-0045「终结即落盘」决策相悖；crash 场景 run 本就随进程死。否。
- **只补 ledger-only 视图、不动 reconcile 治愈路径**：漏掉截图所示的本地卡症状（卡有 runId 走治愈而非 ledger-only）。否。

## Consequences

- 「这个单任务具体跑了哪些工具步骤」在事后回看（换页签 / 刷新 / 重启后）第一次能重建，与实时时间线同口径；体检卡不再只剩「正在启动…/Done」两行。
- `/api/runs/history` 响应体变大（单行内嵌 ≤20 条步骤）——读取端 tolerant，旧行无新字段照常解析；payload 由 200 行上限 + 20 条 cap + label 截断三闸兜住。
- run-events 每个事件多一个 `ts` 字段，缓冲区内存增量可忽略。
- 详情页 live 视图与 ledger-only 视图共用 `StepTimeline`——步骤渲染口径从此单点维护。
- 治愈卡片的步骤来源从「本地猜测」升级为「台账真相 + 本地增量合并」，与 ADR-0031 治愈语义（台账替换猜测）方向一致。

## References

- ADR-0045（批量逐项快照落盘 + `BatchItemList` 共享渲染——本次把同一模式移植到单任务步骤流）、ADR-0042（步骤流/`phase:` 约定/detail 合并/`serverBatchId` 恢复通道）、ADR-0031（僵尸卡对账治愈语义）、ADR-0027 及其 follow-up（run ledger 服务端真相源）、ADR-0043（缺失不占位惯例）。
- 待办：`todo-list/todos.json` #15。
- 工单：`.scratch/single-run-step-persistence/issues/01–04`。
