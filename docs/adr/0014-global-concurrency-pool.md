# ADR-0014: Web 工作器全局并发池

- **Status:** Accepted (2026-09-10)
- **Context:** web 端工作器会把测试重空负载的 AI CLI 子进程无上限并发地 spawn。现状两级,各自独立、均不跨"单元":
  - `/api/run`（单任务 evaluate/pdf）：每请求独立 `spawnHeadlessCli` 一个 CLI 子进程，**无任何并发上限**。几百个任务从单卡逐条发起 → 几百个 CLAUDE 等重型进程同时跑，CPU/内存 无保护。
  - `/api/batch-evaluate`：批内 `MAX_PARALLEL=3`、单批上限 `MAX_URLS=20`，**跨批无队列**。前端可同时发 N 批 → 实际 N×3 并发，批内 3 的"限量"形同虚设。
  - 共享机制仅两个 module-level 内存表：`acquireTrackerWrite`（写令牌，协防 tracker 竞争，单任务 evaluate/pdf 拿）与 active-runs（在飞批快照，前端轮询显示）。spawn 全走统一入口 `spawnHeadlessCli`（detached + `terminateCli` 树终止）。BOSS 直聘扩展也 POST 同一 server，与本进程同 Node process。

  设计目标：**真全局并发上限**——同时运行中的 CLI 子进程总数被一个数字限制，所有入口（web 单卡、web 批量、扩展）共享同一调度。

## Decision

1. **入队粒度为「批内单个 worker」**（Q1）。调度单位是每个 CLI 子进程（每 URL），不是整批批次。全局池并发 N = 真的 N 个 CLI。批次仍是逻辑单元——预占连续报告号 + 最后统一 merge——但槽按 CLI 计，所以批内 3 并发收敛进全局池，3 批同时跑也不再超限。若粒度是「整批」，批内 3 会使 3 批超 N，全局上限名存实亡，故否决。

2. **全槽被占 → FIFO 入队等待（queued）**（Q2）。不 429 拒绝。用户主动发几百任务是重负载前提，拒绝无意义。无优先级插队——先 FIFO，防过度设计，将来数据表明需要再加。

3. **池大小可配，默认 4**（Q3）。存 `config/app-config`，web config 页加字段，默认值兜底。硬编码 3 太死——几百任务是重负载场景，用户应能自我调速。单 worker = 一个重型 agent CLI，本地机并发 3~5 是现实上限，默认取 4。

4. **取得执行槽后才 `acquireTrackerWrite()`**（Q4）。现在 evaluate/pdf 在请求 start 即拿写令牌，协防 tracker 竞争。进池后令牌持有时机改为「真正 spawn 前」。否则几百排队任务全占令牌 → `tracker.mjs delete` 长堵死，一直等到队清空。把「排队」与「执行中」分离，令牌反映真执行态，delete 只在真跑时被挡。

5. **排队取消 = dequeue；执行中取消 = 现状 terminateCli**（Q5）。关键修正：现有 `cancel()` 只对已 spawn 的 child `terminateCli`，对排队任务无效——点掉一张排队 worker 卡，它还在队里照跑。新增 dequeue 路径：从槽等待队列摘除 + 释放该 URL 的批报告号 + 关闭该 worker 的 SSE 流（status=error·cancelled）。执行中取消维持现状树终止。

6. **复用并扩展 active-runs，不新建端点**（Q6）。`/api/active-runs` 从只暴露 in-flight 扩成 `{running, queued}`。前端 worker-list 据此显示排队位置。池大小进 app-config，复用 `/api/config` 读、config-page 加字段。别加专门队列端点，避免 API 漂移。

7. **批入队即整体预占连续号，号按数组序分配，与执行序无关**（Q7）。维持现状：批作为一个逻辑单元，start 时 `reserve-report-num.mjs --count N` 预占连续号。批内 worker 各自抢槽 FIFO 下执行序可能打乱，但报告号按数组序固定分配，不依赖执行序，并发安全不变。排队期哨兵堆的粒度风险接受：单 Node 池队列不跨重启，重启后由现有 4h 哨兵 GC 兜底。

8. **队列不设超时，靠用户取消 + 重启清队**（Q8）。不隐式杀排队任务——用户主动发几百任务 = 接受长队列；服务器重启自然清队。只保留用户显式取消与进程重启两种清队通道。

## Alternatives considered

- **入队粒度=整批**（Q1 否决）：批内仍各跑 3，3 批超全局 N，上限失效。
- **满员即 429 拒绝**（Q2 否决）：几百任务场景拒绝无意义。
- **入队 + 优先级插队**（Q2 否决）：先 FIFO，无数据支撑不早优化。
- **池大小硬编码 3**（Q3 否决）：不可调速，重负载场景太死。
- **排队即拿写令牌**（Q4 否决）：几百任务占令牌 → delete 长堵。
- **新增独立队列端点**（Q6 否决）：与应用现有 active-runs 语义重复。
- **批内 worker 逐个执行时才预占号**（Q7 否决）：批内号不连续则 merge/释放路径复杂化，且并发安全依赖连续号。
- **队列设超时**（Q8 否决）：几百任务长队列是主动选择，隐式杀违背用户意图。

## Consequences

- 所有 CLI spawn（web 单卡/批量/扩展）共享一个并发数字，超限即排队。
- 前端 worker-list 出现「排队中」态（对应 active-runs 的 `queued`），点掉排队卡能真移除。
- 写令牌持有时间 = 实际执行期，`tracker.mjs delete` 只在有 worker 真跑时被挡。
- 磁盘上批报告号哨兵在排队期可能堆积，依赖现有 4h GC + 不跨重启的队列特性兜底。
- 实现集中在单 Node 进程 module-level 调度器，扩展因同进程天然受控。