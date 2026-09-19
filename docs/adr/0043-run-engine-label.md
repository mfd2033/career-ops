# ADR-0043: 工作器运行引擎标示（派发请求值的忠实展示）

- **Status:** Accepted (2026-09-19)
- **Context:** 工作器可见处（`/jobs` 行、侧栏/内联卡片、`/jobs/{id}` 详情页）能回答「谁在跑、跑到哪、跑了多久、花了多少 token」，唯独不能回答「用的是哪个 AI 引擎」。而本机正同时存在两种引擎事实：claude CLI 被赋予 `--model agnes-2.5-flash`（账本里 `[claude-code:unrecognized_model]` 失败与它同源），快评走 key 模式；用户无法从界面判断某次失败或某次产出属于哪个「运行时 + 模型」组合。约束与事实：
  1. 引擎信息在派发边界已经存在（job-store 解析 `readSavedCliId`/`readSavedModel`；扩展从 `/api/config` 解析），随后被丢弃——`StartOpts`、`PoolTaskMeta`、run ledger 记录里都没有它。
  2. 两条真值源并存且都是真的：浏览器 localStorage（web 派发）与服务端 `/api/config`（扩展派发）。二者可能不一致（ADR-0028 的 `#836` 教训：以为存了 claude、实际派发 opencode）。
  3. 「实际用了哪个模型」无法廉价取得：claude stream-json 的 init 事件是否携带 `model` 未经验证（本机转录不含流式事件），其余运行时无结构化输出，失败路径更未必有输出。任何「实际使用」的展示都可能退化为猜测。
  4. 批量入口（`/api/batch-evaluate`、`/api/batch-checkup`）不写 run ledger（ADR-0027 边界）；CLI 交互式路径完全不经过 web 层。
  5. 既有账本记录与已持久化的卡片都没有该字段（历史行）。
- **Scope:** 新增 `web/src/lib/cli-labels.mjs`（运行时显示名单一来源 + 一行格式化规则）；`web/src/lib/clis.ts`（`name` 改读共享表）；`web/src/components/explore/explorer-view.tsx`（删除本地重复表）；`web/src/components/jobs/job-store.tsx`（`Job`/`PoolEntry` 字段 + 派发时写入）；`web/src/lib/core/concurrency-pool.ts`（`PoolTaskMeta`/`Entry`/快照字段）；`web/src/app/api/run/route.ts`（acquire 携带 + 账本记录字段）、`web/src/app/api/batch-evaluate/route.ts`、`web/src/app/api/batch-checkup/route.ts`（acquire 携带）；三个展示面（`worker-card.tsx`、`jobs/page.tsx` 行、`jobs/[id]/page.tsx`）；`web/src/lib/i18n/clusters/jobs.ts`（中英双份）；测试。**不改动**：`/pipeline`、run ledger 的既有字段与粒度、扩展代码、`modes/*`、配置存储格式、`/api/run` 的请求契约（`cliId`/`model` 本就是请求参数）。

## Decision

1. **术语 = 「运行引擎（run engine）」**：某工作器被派发时请求的 CLI 运行时 + 模型。定义与边界写进 `CONTEXT.md`（区别于「引擎模式」与「当前使用」——那两者说现在，它说当时）。
2. **事实口径 = 请求值，绝不读实际值**：展示的是派发那一刻的请求值快照，永不声称实际加载的模型。这是唯一不需要验证各 CLI 内部行为的诚实口径（也是约束 3 的直接后果）。
3. **记录点只在既有派发边界**：web 单卡/批量（job-store 解析后写入 `Job`，同一对值随请求进入路由）与扩展（经 `/api/config` 解析后随请求进入 batch 路由）。并发池 `PoolTaskMeta` 与 `/api/active-runs` 快照携带 `cliId`/`model`，因此扩展派发的临时卡片也带引擎；`/api/run` 把它写进 run ledger（ADR-0027），因此浏览器外的历史行也带引擎。**不新增**账本写者、不改账本粒度。
4. **缺失口径**：列表（卡片、`/jobs` 行）不占位；详情页（含 ledger-only 视图）明写「未记录（早于该功能）」。不做回填、不猜测。
5. **所有状态都显示**：queued/running/done/error 一律呈现——引擎是任务的属性，不是结果的一部分。
6. **UI = 三处信息行**：worker 卡片（tokens 行之前）、`/jobs` 行（副标题行之下）、`/jobs/{id}` 详情页标题块内。文案 `运行引擎：Claude Code · agnes-2.5-flash` / `Engine: …`；悬停标题解释「派发给」语义；未指定模型时只显示运行时。
7. **运行时显示名单一来源 = `cli-labels.mjs` 的 `CLI_LABELS`**：`clis.ts` 的 `name` 与 explore 页的本地表都改读它；未知 id 回退原始 id（不猜测、不隐藏）。

## Alternatives considered

- **为批量/扩展任务新增账本写入方（每项一条记录）**：账本粒度是「一次性终止运行 = 一条记录」（ADR-0027），per-URL 记录会改写该契约并引入新的并发写者；扩展派发的引擎改由并发池快照承载即可（进程内、与临时卡片同生命周期）。
- **读实际模型（解析 claude init 事件 / 各 CLI 输出）**：唯一未验证的关键事实（约束 3），落成展示就是猜测；且失败路径常常无输出，恰好是最需要它的时候最不可靠。否。
- **先统一两个配置源（localStorage 与 `/api/config`）再展示**：那是配置同步的另一件事（ADR-0028 已定路径），还会掩盖「这次到底派发了哪个值」——两个源各自忠实展示，不一致本身就是有用的信号。
- **`/pipeline` 行同时加引擎列**：pipeline 行是报告号粒度，可能对应多次复评（每次引擎都可能不同），且报告文件与 tracker 都不记录引擎，需要新的持久化通道；本轮不做，留作后续。
- **CLI 交互式路径也记录**：该路径不经 web 层、无 `Job`/账本可挂，需要新的模式文件协议；明确留白。

## Consequences

- 界面能回答「这次失败/这次产出是哪个运行时 + 模型组合」：`[claude-code:unrecognized_model]` 一类失败不再与引擎脱钩。
- 本功能之前的历史行在详情页显示「未记录（早于该功能）」，列表不显示——不伪造回填。
- 批量/扩展的临时卡片带引擎，但批量历史仍无账本（ADR-0027 边界未变）。
- 运行时显示名从两份（`clis.ts`、`explorer-view.tsx`）收敛为一份；explore 页 Copilot 标签随之从「Copilot CLI」变为与配置页一致的「GitHub Copilot CLI」，并补上此前缺失的 Grok Build CLI。
- 向后兼容：`cliId`/`model` 缺失即走「未记录」路径，不做版本门禁（老扩展、老持久化卡片照常工作）。
- `/jobs` 行在副标题之外多一行文字，窄屏下与副标题同宽截断。

## References

- ADR-0018（工作器引用报告号——同为「工作器属性」的展示先例）、ADR-0020（工作器事件通道）、ADR-0027（run ledger 及其粒度）、ADR-0028（`cliId`/`model` 保存回执——双源不一致的教训 `#836`）、ADR-0042（工作器展示面与步骤窗口）。
- `web/src/lib/cli-labels.mjs`（新增）、`web/src/lib/clis.ts`、`web/src/components/jobs/job-store.tsx`、`web/src/lib/core/concurrency-pool.ts`、`web/src/app/api/run/route.ts`、`web/src/app/jobs/[id]/page.tsx`。
- 术语表词条：`CONTEXT.md` 的「运行引擎（run engine）」。
