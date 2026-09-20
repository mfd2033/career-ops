# ADR-0045: 工作器历史批量任务逐项展开（台账落盘 + 列表 chevron 展开）

- **Status:** Accepted (2026-09-20)
- **Context:** `/jobs` 历史页里批量任务（批量评估、批量体检）只显示一行「评估·批量」，具体跑了哪几家、结果如何要点进详情页且仅当数据还在时可见。既有事实链：批量逐项结论有两个运行时来源——持有 NDJSON 流的那个页签在 `Job.items` 里累积（localStorage 持久化，cap 100），以及服务端进程内登记表（`batch-items.mjs`，ADR-0042 决议 6，重启即清、完成后可被淘汰）；而批量路由**根本不写 run ledger**（`appendRunRecord` 只在单次 `/api/run` 调用），UI 之外发起的批量终结后在历史里完全不可见。约束与事实：
  1. 详情页已有逐项面板（`JobItem` 形状：key/label/ok/skipped/score/star/reason/ts），列表展开不应另造一套口径。
  2. 历史页合并本地卡与台账行凭 run id 去重；批量本地卡不带 `runId`，但 open 事件已下发 `serverBatchId`——现成的匹配键。
  3. 当前批量单 run 上限 20 项（`MAX_URLS`/`MAX_ITEMS`），items 全量内嵌台账的体积风险是防御性的而非现实的。
  4. 运行中批量的逐项数据在登记表里，拉取通道（`GET /api/batch-items`）与容错模式（3s 轮询、瞬时失败静默）详情页已验证过。
- **Scope:** `web/src/app/api/batch-evaluate/route.ts`、`web/src/app/api/batch-checkup/route.ts`（终态落台账）、`web/src/lib/batch-ledger.mjs`（新，记录组装纯函数）、`web/src/lib/ledger-merge.mjs`（新，去重纯函数）、`web/src/lib/batch-summary.mjs`（新，折叠计数纯函数）、`web/src/lib/batch-live.mjs`（新，轮询判定/归并纯函数）、`web/src/app/jobs/page.tsx`（展开 UI）、`web/src/app/jobs/[id]/page.tsx`（ledger-only 批量视图 + 渲染复用共享组件）、`web/src/components/jobs/batch-item-list.tsx`（新，共享渲染）、`web/src/components/jobs/job-store.tsx`（`Job.batchTotal` 可选字段）、`web/src/lib/i18n/clusters/jobs.ts`（中英双份）、测试。**不改动**：登记表内存语义、`/api/runs/history` 读取逻辑（透传天然带出新字段）、单次 run 的台账形状。

## Decision

1. **展示位置 = 历史列表内展开子项**：批量行左加 chevron，点击展开/折叠；点行其余区域仍进详情页。不拆独立行（列表被批量灌爆）、不只做详情页（用户明确要「历史里就能看到具体任务」）。
2. **持久性 = 服务端落盘**：批量 run 终结（done / error / cancel 都算）时把逐项快照写入台账。localStorage 卡片够用论被否——扩展/脚本/别的浏览器发起的批量是本功能的主要盲区。
3. **子项信息量 = 最小集**：名称 + ✅/⚠️/⏸ 结果 + 分数/星级 + 失败原因（即既有 `JobItem` 全字段），不加报告链接、不做完整子卡片（那需要每项的开始/结束戳，改动面与价值不匹配）。
4. **范围 = 两个现有批量 kind**（`batch-evaluate`、`batch-checkup`），扫描等「伪批量」不在本次。
5. **台账覆盖 = 批量 run 也进台账**：一行一个批量 run，id = `serverBatchId`，title 形如「批量评估 · N 项」；顺带补上 ADR-0027 可观测性精神里批量缺失的一角。
6. **存储布局 = items 内嵌主台账**（`index.jsonl` 单条记录内），不拆指针文件——当前批量十项级，简单优先；将来 payload 膨胀再演进为摘要 + `itemsFile`。
7. **交互 = 手动展开、默认折叠**：不做运行中自动展开、不做全部默认展开。
8. **运行中 = 实时轮询**：展开 running 批量时复用 `/api/batch-items` 3s 轮询点亮子项；折叠不轮询（不为不可见的数据花请求），终态停轮询收敛到落盘快照，不回退不闪空。
9. **折叠摘要 = 「n 项 · x 成功 · y 失败」**：从 items 现算，不新增存储；skipped 单列不算失败（ADR-0041 决议 5 口径）；n 取 `total` 与 items 数的较大者（快照截断/部分完成时总数不失真）。
10. **推定结论（拷问会话中声明、未被否决）**：
    - 去重键扩展：单次 run 认 `runId`，批量认 `serverBatchId`，同一批量本地卡胜出、绝不出双行。
    - 半途终结（cancel/异常）保留已完成部分的 items 一并落盘。
    - 单条台账内嵌上限 100 项（防御性），溢出仅记 total。
    - 无 items 数据的历史 run 不显示 chevron——诚实空白，不回填不伪造（沿 ADR-0043 缺失惯例）。
    - ledger-only 详情视图顺带渲染逐项快照（与列表展开同一共享组件）。

## Alternatives considered

- **子任务独立成行**：每个子项在历史里占一行，免二次点击，但一个 20 项批量灌 20 行，破坏「批量是一个工作单元」的心理模型，也与并发池单项卡的语义打架。否。
- **明细另存独立文件 + 台账放指针**：列表首屏 payload 最小，但多一套文件生命周期与拉取路由；当前规模是过度设计。否（保留为台账膨胀后的演进路径）。
- **边跑边实时落盘（append-only 逐项）**：进程 crash 也不丢已完成项，但双写者（内存登记表 + 磁盘）一致性成本高；「终结即落盘」已覆盖常态，crash 场景批量本就随进程死。否。
- **只存明细、不给 UI 外批量建行**：台账行没有归属意义（ledger 的契约是「发生过什么 run」）。否。
- **localStorage items 够用论**：零服务端改动，但换浏览器/清存储/扩展发起即失明，与 ADR-0027 确立的服务端真相源方向相反。否。

## Consequences

- 「这个批量具体跑了哪几家、都成没成」在历史页一次展开即答；UI 外发起的批量第一次有了终结痕迹（含逐项）。
- `/api/runs/history` 响应体变大（批量行内嵌 ≤100 项）——读取端 tolerant，旧行无新字段照常解析；payload 风险由 200 行上限与 100 项 cap 双闸兜住。
- `Job` 多一个可选字段 `batchTotal`（仅 ledger-only 行填充），localStorage 旧卡片无它走 `items.length` 回退，无版本门禁。
- 详情页、列表展开、ledger-only 三处共用一个 `BatchItemList` 渲染——最小集口径从此单点维护。
- 折叠摘要行替换了批量行的旧 subtitle 位置——批量卡原本副标题只有一句笼统描述，信息严格变多。

## References

- ADR-0042（批量逐项登记与 `serverBatchId` 恢复通道）、ADR-0041（批量体检与 skipped 不算失败口径）、ADR-0027 及其 follow-up（run ledger 服务端真相源）、ADR-0043（缺失不占位惯例）、ADR-0044（列表行时间戳语义——本次不触碰）。
- 工单：`.scratch/batch-history-items/issues/01–04`。
- 术语表词条：`CONTEXT.md` 的「批量逐项快照」。
