# ADR-0093: 批量评估失败子项的手动重试

- **Status:** Accepted (2026-10-31)
- **Context:** ADR-0061 给了工作器任务失败后的整卡重试，但决议 2 明确把「按失败项重试」留作二期：一个 20 项的 batch-evaluate 只要死 1 项，用户要么整批重跑（已成功的 19 项重复烧 token），要么回原页面逐条重新派发。批量详情页与 /jobs 展开区的 `BatchItemList` 已把每个子项渲染成卡片，失败项带着 `reason`，但没有任何补救入口。约束：

  1. **批量失败项的 key 就是 posting URL**（`batch-items.mjs`：evaluate 用 URL，checkup 用 tracker#），单次评估 `kind="evaluate"` + `input=URL` 的派发路径已经存在（收件箱行内评估、`ReevaluateButton`）。
  2. **`item-running` 占位与终态失败同形**（`ok=false`）：占位项没有 `reason`，服务端终态失败项一定有非空 `reason`（`batch-evaluate/route.ts` 的 reason 判定链）。
  3. **父批量的 `items` 是历史结论**：服务端登记表与落盘台账都以 batchId 为键、幂等写入；把重试结果反写回父批量需要跨 run 的对账与幂等合并，ADR-0061 明确列为二期成本。
  4. **checkup 批量不能直接重试**：单次体检必须先过 `POST /api/checkup-request` 前哨（no-via 门、同 tracker# 在跑去重、替换语义），绕过它等于给用户一条静默重入通道。

- **Scope:** web 层——新纯函数 `web/src/lib/batch-item-retry.mjs` + 单测、`job-store.tsx` 的启动引擎快照入参、`BatchItemList` 失败项的重试按钮与 i18n（jobs cluster，en+zh）。**不动**：服务端 API 与批量数据结构（`items` 合并/对账零改动）、checkup 批量重试、自动重试、父批量卡片的状态。

## Decision

1. **只对终态失败的 evaluate 子项提供入口**：`!ok && !skipped && reason 非空 && key 是 http(s) URL`。进行中占位、跳过项、成功项、checkup 项（tracker#）都不渲染按钮。
2. **重试 = 派发一个独立单任务工作器**（`kind="evaluate"`、`input=失败项 URL`），而不是重跑父批量、也不复用父卡。父批量的失败证据（reason、单项清单）原样保留；新 run 在台账里是独立记录，可在 /jobs 直接打开。
3. **引擎沿用父批量的派发快照**：`BatchItemList` 已持有 `cliId`/`model`（批量卡与台账行都带），重试派发用这一对值，缺失才回退当前设置——与 ADR-0061 决议 5「原样再来」同口径。为此 `StartOpts` 增加可选 `cliId`/`model`。
4. **防重复派发**：同 URL 已存在 `running`/`queued` 的 `evaluate` 卡时，按钮位显示「重试中…」而非可点按钮（单 URL 串行、避免误触刷屏式重复消费）。
5. **不做二次确认**：单项重试与行内评估同代价，一次点击直达；与 ADR-0061「批量整卡重跑才拦截」的分级一致。
6. **组件无 hooks 依赖的判定抽成纯函数**：`canRetryBatchItem` 与 `hasLiveEvaluateForUrl` 放 `.mjs`，`node --test` 锁定（沿用 ADR-0057/0061 的既有缺口补法）。

## Alternatives considered

- **把失败子集塞回父卡重跑**（`urls = 失败项`）：复用整卡重试路径最短，但 `resetJobForRetry` 会清空父卡 `items`，已成功项的结论当场消失，违背「失败证据完整保留」的既有哲学；否决。
- **就地补跑并反写父批量 items**：体验最好，但要动批量登记表、items 幂等合并、子台账对账，且「父批量已终态、期间又有新 run」的语义无既有先例；本项目范围外，留作后续。
- **checkup 批量同样加重试**：必须接 `/api/checkup-request` 前哨，还要处理「同 tracker# 已在跑 → 替换面板」的裁决流；与本次「批量评估」诉求不重合，另行立项。
- **整卡重试代替单项**：已有（ADR-0061），这正是要解决的问题。

## Consequences

- 失败项的补救成本从「整批 20 次评估」降到 1 次；代价是新增一张独立卡片与一条台账记录，父批量的计数不变（用户可能看到「1 failed」同时顶部有新的重试 worker——这是如实的两个事实）。
- `StartOpts` 的引擎字段是可选的，既有调用点行为不变；`resolveEngineFallback` 仍是缺省路径。
- 批量登记表、`/api/batch-items`、`/api/batch-evaluate` 零改动，无新增服务端状态。

## References

- ADR-0061（工作器任务重试；本 ADR 接续其决议 2 的二期）
- ADR-0042/0045/0046（批量逐项清单、登记表、子任务台账）
- ADR-0057（内嵌确认弹窗先例——本 ADR 按决议 5 不使用）
- `web/src/components/jobs/batch-item-list.tsx`、`web/src/components/jobs/job-store.tsx`、`web/src/lib/batch-item-retry.mjs`、`web/src/lib/i18n/clusters/jobs.ts`
- 实现工单：`.scratch/batch-item-retry/issues/01-batch-item-retry.md`