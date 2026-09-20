# ADR-0044: 工作器开始时间展示（排队/执行/终止三段诚实时间链）

- **Status:** Accepted (2026-09-20)
- **Context:** 工作器三个展示面（侧栏托盘卡片、`/jobs` 历史列表、`/jobs/{id}` 详情页）都无法回答「这个任务是什么时候开始的」。running 只有实时 tick 计时（`1:23`），done/error 只有时长——绝对时间全靠脑算。而数据链路的时间戳大体已存在：前端 `Job.startedAt`（派发那一刻写入，含排队段）、run ledger 的 `startedAt`/`finishedAt`、并发池快照的 `enqueuedAt`。已核实的一处语义缺陷：池的 `PoolRunningTask.startedAt` 直接取 `enqueuedAt`，即「执行开始」当前冒充的是「入队时间」，长排队会让计时虚高。约束与事实：
  1. 侧栏托盘是最窄展示面（10px 小字行），`/jobs` 行右侧已有时长位，详情页空间充裕——三处的密度预算天然不同。
  2. 时长展示已有既定口径（ADR-0016 评估用时 / ADR-0042 阶段展示），本决策不触碰时长语义，只补绝对时间。
  3. 扩展派发、另一页签派发的任务没有本地卡片，其进行中状态来自 `/api/active-runs` 池快照（进程内、不持久化，ADR-0014）；终态历史来自 run ledger（ADR-0027）。两条通道的时间戳形状不同。
  4. 本功能之前的历史行与老 localStorage 卡片没有新字段——与运行引擎（ADR-0043）同款的缺失场景。
- **Scope:** `web/src/lib/core/concurrency-pool.ts`（running 条目补真实执行开始戳）、`web/src/components/jobs/job-store.tsx`（`Job` 可选 `runningStartedAt`，queued→running 迁移时捕获）、`web/src/components/jobs/worker-card.tsx`（tray/inline 三段式）、`web/src/app/jobs/page.tsx`（行加「始于」）、`web/src/app/jobs/[id]/page.tsx`（详情页时间链，含 ledger-only 视图）、共享时间格式化纯函数（新）、`web/src/lib/i18n/clusters/jobs.ts`（中英双份）、测试。**不改动**：run ledger 字段与粒度、评估用时口径（ADR-0016）、`/pipeline`、扩展代码、`modes/*`。

## Decision

1. **三处统一展示绝对开始时间**：侧栏托盘卡片、`/jobs` 列表行、`/jobs/{id}` 详情页都显示，信息一致不漂移。
2. **格式 = 当天时分、跨日补日期**：与设备本地时区的「今天」比较；当天 `HH:MM`，非当天 `MM-DD HH:MM`。由一个纯函数承载（三处共用，可单测），不引入日期库。
3. **终态并列**：done/error 显示「始于 HH:MM」+ 现有时长两段并列（列表在右侧时长位同行，卡片在时长行内），不互相替换。
4. **排队与执行语义分开（诚实时间链）**：
   - 并发池 running 条目新增真实执行开始戳（取得执行槽、spawn CLI 那一刻），快照的 `startedAt` 改指它；`enqueuedAt` 保留。
   - queued 态显示排队起点：`排队中 · 自 HH:MM`（数据源即 `enqueuedAt`）。
   - 前端本地卡片观察到 queued→running 迁移时记录 `runningStartedAt` 并随 localStorage 持久化；显示「始于」时优先 `runningStartedAt`，缺失（未经排队直接跑）回退 `startedAt`。
5. **tray running 行 = 三段式**：`14:32 · 正在撰写报告 · 1:23`（始于 · 阶段 · tick），超宽由现有 truncate 截尾，接受尾部计时被截的风险换取信息完整。
6. **详情页 = 完整时间链**：`排队于 → 始于 → 止于 · 共 X 分`，缺段省略（无排队段则不显示排队于；ledger 记录无排队信息，ledger-only 终态视图只显示始于/止于/时长）。
7. **缺失口径沿用 ADR-0043 惯例**：时间戳缺失的老记录不显示、不占位、不回填、不猜测。
8. **i18n 键 en/zh 双份**入 `jobs` 簇；文案「始于/排队于/止于」对应 `Started/Queued/Ended`。

## Alternatives considered

- **入队时间即开始时间（零服务端改动）**：直接显示 `enqueuedAt` 即可交差，但长排队时「已跑 40 分钟」虚高，与 ADR-0042 确立的「展示只说真话」纪律冲突。否。
- **托盘不加、只列表/详情页加**：省掉最窄面的截断风险，但用户决策明确要三处一致（「我看了眼侧栏想知道它是几点起的」不该靠 hover）。否。
- **hover tooltip 显示开始时间**：零布局成本，但可见性最差，且触屏/扩展内嵌场景没有 hover。否。
- **把排队段/执行段写进 run ledger**：账本粒度是「一次性终止运行 = 一条记录」（ADR-0027），排队发生在进程内池里，为展示扩账本字段引入新写者与新契约；进行中任务的排队起点由池快照承载即可。否。
- **详情页只加开始时间**：结束时间靠「开始+时长」反推，把计算负担留给读者；详情页是唯一有空间放全链的界面。否。

## Consequences

- 「这个挂了 40 分钟的任务到底几点开始跑的」在三个界面都能直接回答；排队久的任务不再谎报执行时长。
- `/api/active-runs` 响应形状加字段（`enqueuedAt` 本就存在，`startedAt` 语义修正为真实执行开始）——读方只有前端 job-store，老前端读到新形状无害；老扩展不受影响。
- localStorage 卡片多一个可选字段 `runningStartedAt`，老卡片缺它走回退路径，无版本门禁。
- tray running 行变长，窄侧栏下阶段名或 tick 可能被 truncate 吃掉——接受（用户显式选择三段式）。
- 本功能之前的 ledger 行照常显示「始于」（它一直有 `startedAt`），只有新增的排队语义对老数据不可见——不伪造。

## References

- ADR-0043（缺失不占位惯例）、ADR-0042（工作器进度展示与「阶段只描述进行中」纪律）、ADR-0016（评估用时口径——本次并列而不替换）、ADR-0014（全局并发池）、ADR-0027（run ledger 粒度）。
- `web/src/lib/core/concurrency-pool.ts`、`web/src/components/jobs/job-store.tsx`、`web/src/components/jobs/worker-card.tsx`、`web/src/app/jobs/page.tsx`、`web/src/app/jobs/[id]/page.tsx`。
- 术语表词条：`CONTEXT.md` 的「执行起点（started running）」。
