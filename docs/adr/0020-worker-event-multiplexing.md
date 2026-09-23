# ADR-0020: 工作器事件多路复用——每任务不再独占一条 HTTP 连接

- **Status:** Accepted (2026-09-13)
- **后续：** 决议 4 仍有效（`/api/batch-evaluate` 形状不改，popup 多选评估还在读它），但 Alternative 里「等扩展有需求时让它也消费事件通道」已在 [ADR-0051](0051-extension-single-eval-via-run.md) 部分兑现：扩展的单职位评估从此常驻 `/api/events`。
- **Context:** 用户报告「工作区有多个任务在进行时，点击页面其他功能没有反应」。诊断（复现回路 `web/tests/debug/ui-freeze-multiple-tasks.mjs`，Playwright + 反向代理实测）：旧传输下每个任务——**运行中或排队中**（`/api/run` 在池发放槽位前就返回流式响应，靠 10s keepalive 保活）——都持有自己的流式 HTTP 响应；HTTP/1.1 浏览器对同源主机上限 6 条连接，约 6 个并发任务后所有**新**请求（点击其他功能触发的页面数据 fetch、worker 列表自身的 3s 轮询）在 socket 队列中排队，页面表现为「点了没反应」，直到任务结束连接释放才恢复。实测：同源 fetch 延迟 基线 87ms → 持 5 条流 19ms → 持 6 条流 >15s 停滞，阈值恰为浏览器硬限制，确定性复现。前端没有全局遮罩/禁用（`apply-backdrop` 明确 `pointer-events:none`），点击事件本身正常——是请求发不出去。

## Decision

1. **`POST /api/run` 不再流式返回工作器输出**。它校验后向事件总线注册 `runId`，立即返回 `{runId}`，管线转入后台执行（`after()`），所有事件 `publish` 到 `lib/core/run-events.ts`（进程内总线：每 run 事件缓冲 + 扇出 + 单调 `seq` + 取消注册表）。**任务的连接成本从 1 变 0**。
2. **`GET /api/events` 是唯一的复用通道**（NDJSON，`{runId, ev}` 帧，15s keepalive）。每个标签页只持这 1 条长连接；连接时回放所有已记录 run 的缓冲（重连/迟到客户端不丢事件），客户端按每事件 `seq` 去重，重连后步骤不重复。多标签页各自持 1 条，不再随任务数放大。
3. **取消从「断开连接」改为显式 API**（Q1）。旧流传输靠客户端断开（`ReadableStream.cancel`）取消运行；没有常驻流后语义改为：worker 卡片 X → `POST /api/run/cancel {runId}`（排队 run 出队、运行中 run 按进程树终止 CLI 并释放写令牌与池槽）。**行为变化：关闭标签页不再终止运行中的 CLI**——它无头跑完（与扩展发起的批量评估一直如此），刷新后卡片按既有逻辑显示「已中断」。
4. **`/api/batch-evaluate` 保持 NDJSON 流不变**（Q2）：`extension/background.js` 直接解析它的流（ADR-0002/0005），改响应形状会破坏扩展；且一批 = 1 条连接，不在主要成因里。job-store 的批量分支保留原有 per-batch 流读取。
5. **总线核心落 `lib/core/run-events.ts`、可被 `node --test` 直接导入**（房规，同 concurrency-pool.ts），配 `web/tests/lib/run-events.test.mjs`；`/api/run` 的诚实门、kill 计时器、pdf 渲染收尾等逻辑逐字保留，仅换了传输层。回归回路的红色信号改为**连接拓扑断言**：8 个任务并发时页面必须只持 1 条 `/api/events`、0 条 per-task 流，且点击等价 fetch 保持快速。

## Alternatives considered

- **排队期不占连接 + 运行期重连取流**（否决）：改动较小但需要同样的每-run 事件缓冲，而 6 个运行中任务仍顶满 6 连接上限——只缓解不治愈，且 job-store 从此有两种取流路径。
- **`/api/batch-evaluate` 一并迁移**（否决，Q2）：破坏扩展解析；等扩展有需求时让它也消费事件通道即可。
- **HTTP/2 / WebSocket**（否决）：本地 standalone server 引入 h2/WS 栈是为一个已定位的问题换整套传输协议；NDJSON 复用通道与代码库既有流风格一致。
- **降低池并发到 4 以下**（否决）：排队任务本来就占连接，治标且牺牲吞吐。

## Consequences

- 点击无响应的根因消除：任意数量任务并发，每标签页只占 1 条连接；worker 卡片更新改由事件通道驱动（服务端快照轮询保留，负责排队状态与扩展来源卡片）。
- 关闭/刷新页面不再杀死 CLI（取消必须点卡片 X）；旧版标签页在部署后的第一次 `/api/run` 会拿到 `{runId}` 而非流——刷新一次即恢复，本地一次性工具可接受。
- `run-events.ts` 的缓冲有 FIFO 上限（50 run / 500 事件），重连回放覆盖近期运行；跨进程（CLI 直跑）不经过总线，那是另一条通道（tracker/报告文件）。
- 复现/回归回路 `web/tests/debug/ui-freeze-multiple-tasks.mjs` 需先 `npm run build`（turbopack dev 在无头环境不 hydrate，且生产形态与 launcher 一致）。
