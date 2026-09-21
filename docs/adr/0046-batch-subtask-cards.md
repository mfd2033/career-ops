# ADR-0046: 批量子任务卡片化 + 独立详情行

- **Status:** Accepted (2026-09-21)
- **Context:** ADR-0045 让批量 run 在 `/jobs` 历史页可展开逐项，但决议 3 明确「子项是最小集、行不可交互、不加报告号、不做完整子卡片」。用户新要求：工作器里批量任务展开后，把子任务显示成**卡片**，**可点击查看子任务详情**——且详情要「和单独执行任务时的页面一样」（`/jobs/{id}` 工作器详情页，非报告页）。既有事实链：
  1. 批量在台账里原本只有「一行 = 一个工作单元」；单个子项没有独立 run 记录，也没有可被 `/jobs/[id]` 解析的 id。
  2. 批量路由读子 worker 的输出是**纯文本**（抽 VERDICT/ERROR 行），从不捕获逐工具步骤流；而**单次 run 复看时**（不在 localStorage）详情页本就落 ledger-only 诚实子集视图、同样没有步骤流——所以「和单次任务页一样」等价于「和重开的历史单次任务页一样」，诚实子集即可，无需改造批量采集步骤。
  3. batch-evaluate 每个子项在派发时预分配了 `reportNum`（`reserve-report-num.mjs --count N`），但 ADR-0045 没把它落到逐项记录上；batch-checkup 的产物以 tracker# 为键（`reports/checkups/*.html` + `company-checkups.tsv`），其 `key` 本身就是报告键。
  4. 报告查看通道现成：`/report/{num}`（评估报告）、`/api/checkup-report?n=`（体检 HTML，`target="_blank"`，带前缀+根包含校验，ADR-0026 决议 3）。
- **Scope:** `web/src/lib/batch-items.mjs`（逐项记录新增 `reportNum`/`startedAt`/`finishedAt`）、`web/src/lib/batch-child-ledger.mjs`（新，确定性子行 id + 组装 + 可点判据纯函数）、`web/src/app/api/batch-evaluate/route.ts`、`web/src/app/api/batch-checkup/route.ts`（成功项即时落子行 + 逐项事件/登记表带新字段）、`web/src/lib/ledger-merge.mjs`（列表排除 `parentId` 行）、`web/src/components/jobs/job-store.tsx`（`JobItem` 扩字段 + 解析）、`web/src/components/jobs/batch-item-list.tsx`（行→可点卡片）、`web/src/app/jobs/page.tsx`、`web/src/app/jobs/[id]/page.tsx`（卡片宿主传 batchId/引擎、子行详情报告链接）、`web/src/lib/i18n/clusters/jobs.ts`。**不改动**：单次 run 台账形状、并发池语义、批量父行的内嵌快照与折叠摘要、内存登记表生命周期。

## Decision

1. **点击去向 = 子任务自己的 `/jobs/{childId}` 工作器详情页**（不是直跳报告，也不是弹窗）。报告在详情页内以链接呈现。
2. **内容保真 = 对齐「重开的历史单次任务」诚实子集**：状态/引擎/时间链/时长/结果 + 报告链接；**不**捕获逐工具步骤流（单次任务复看时也没有）。
3. **子任务身份 = 每条独立 run 台账行**，`parentId = serverBatchId`；`/jobs` 列表按 `parentId` 排除子行（列表仍一批量一行，守住 ADR-0045「批量是一个工作单元」），但 `/jobs/[id]` 凭子行 id 照常解析。
4. **建行范围 = 仅成功落盘的子项**写子行、可点；失败/跳过/取消项**不建行**、卡片不可点、原因内联（没有可跳报告的子行是空壳）。
5. **写入时机 = 子项一成功即即时落子行**（不等批量整体终态）：运行中的批量里已完成的子任务也能点开。父批量自身的终态台账行与内嵌 `items` 快照保留不变。
6. **确定性 id** = `fnv1a(batchId::key)`（纯 JS、非 `node:crypto`，服务端落盘与前端卡片算出同一值）；`key`：evaluate=URL，checkup=tracker#。URL 路径段安全（`bci-` + hex）。
7. **报告关系 = 详情页链接跳转**：evaluate → `/report/{num}`（站内 `ReportNumLink`）；checkup → `/api/checkup-report?n={tracker#}`（新标签，沿用体检按钮现状）。
8. **卡片信息 = 完整卡片**：状态图标 + 名称/公司 + 分数/星级 + 完成时刻 + 引擎 + 时长 + 失败/跳过原因；成功项整卡可点。引擎取批量派发请求值（子项继承），时长取子项 `startedAt/finishedAt`。
9. **两处共用** `BatchItemList`（历史列表展开 + 批量详情页），同一 `JobItem` 口径。
10. **数据通道扩展 = 显式推翻 ADR-0045 决议 3** 的「不存报告号 / 不做完整子卡片」：`BatchItem`/`JobItem` 新增可选 `reportNum`/`startedAt`/`finishedAt`；读取端 tolerant，旧记录/旧卡片无这些字段照常解析、缺失不占位（沿 ADR-0043）。

## Alternatives considered

- **直跳报告页 `/report/{num}`**：少一层，但用户明确要「和单独执行任务一样」的工作器详情页语义；报告作为详情页内链接更贴合。否。
- **捕获逐工具步骤流（把批量 worker 改 stream-json 事件解析）**：与 `/api/run` 对齐、详情页更「满」，但要重写批量编排的事件读取、破坏纯文本读 VERDICT 的现有契约，且与「单次任务复看本就没步骤」相比是过度投入。否。
- **失败/跳过也建子行**：可点开看错误原因，但无报告的详情近乎空壳、徒增台账行；原因已内联卡片可读。否。
- **子任务直接作为一级行进 `/jobs` 列表**：免二次点击，但一个批量灌 N 行、破坏工作单元心理模型（ADR-0045 已否决，本次维持）。否。
- **不新增台账行、子任务页从父行 `items` 快照临时合成**：零新增行，但快照项无独立 id、跨页签/刷新/无本地卡时子任务页取不到；独立台账行才让 `/jobs/[id]` 天然可解析（ADR-0027 服务端真相源方向）。否。

## Consequences

- 一个批量在台账里出现「1 父行 + ≤ 成功数 个带 `parentId` 子行」；`/api/runs/history`（200 行上限）会被成功子行占用——单批量 ≤20 可接受，重度批量使用会缩短历史覆盖窗口，记为已知后果（后续可演进为分页 / 子行独立端点）。
- 逐项记录新增三可选字段，旧记录与旧 localStorage 卡无它走缺省（不可点、无时长），无版本门禁。
- 卡片点击的目标 id 与子行 id 必须同算法（`batch-child-ledger.mjs` 单点提供），否则点开 404；已用纯函数测试锁定确定性。
- 子行是 fire-and-forget 落盘：台账写失败绝不反噬 run（与父批量、`/api/run` recordEnd 同纪律）。
- 影子备份：本次只新增 run 台账子行（`.career-ops-web/runs/index.jsonl`，运行时产物，非个人数据白名单）；未新引入对个人数据层的批量改写。

## References

- ADR-0045（本次推翻其决议 3「不存报告号/不做子卡片」，保留其父行快照、折叠摘要、去重键、列表不灌爆原则）、ADR-0042（逐项登记表 + `serverBatchId`）、ADR-0041（体检与 skipped 不算失败口径）、ADR-0027（run 台账服务端真相源）、ADR-0026 决议 3（体检 HTML 读取路由）、ADR-0043（缺失不占位惯例）、ADR-0044（时间链语义）。
- 工单：`.scratch/batch-subtask-cards/issues/01–06`。
- 术语表词条：`CONTEXT.md`「批量子任务详情行」。
