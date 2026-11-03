# ADR-0095: 批量评估的整卡重试只重跑失败项

- **Status:** Accepted (2026-11-03)
- **Context:** ADR-0061 给了工作器任务失败后的整卡重试，但重试语义是「整批从头重跑」：`resetJobForRetry` 沿用卡上的 `urls`/`ns` 快照原样重发，确认弹窗也明写「已成功项也会重新执行」。ADR-0093 补上了「单个失败子项 → 独立工作器」的入口，粒度却对不上真实故障：一个 20 项的 `batch-evaluate` 常在尾部死 1–2 项（CLI 额度耗尽、单条 JD 抓取失败），用户要么点单项重试按钮 N 次、攒出 N 张散卡，要么整批重跑把已成功的 18 项再评估一遍——重复烧 token、重复覆盖已生成的报告。约束：

  1. **原始清单只能从 `urls`/`ns` 快照取**（ADR-0061）：`items` 是结论清单，被 `slice(-100)` 截断过，不能反推原始派发参数。
  2. **`items` 的 key 就是派发键**：`batch-evaluate` 用 URL，`batch-checkup` 用 tracker#，与 `urls`/`ns` 同源，可以精确对账。
  3. **`item-running` 占位与终态失败同形**（ADR-0093 修订 1）：`ok=false`、可能没有 `reason`。流断掉时它代表「结论丢失」，同样需要重跑。
  4. **ADR-0093 曾否决「把失败子集塞回父卡重跑」**，理由是 `resetJobForRetry` 会清空父卡 `items`，已成功项的结论当场消失，违背「失败证据完整保留」。这条否决是本 ADR 必须正面解决的问题，而不是绕过。
  5. **checkup 批量不适用**：单次体检必须先过 `POST /api/checkup-request` 前哨（no-via 门、同 tracker# 在跑去重、替换语义，ADR-0093 决议 4）；`skipped-running` 项在重试时刻语义也已变（那一批可能早已结束）。

- **Scope:** web 层——`web/src/lib/job-retry.mjs` 新增纯函数 `batchRetryPlan` 并改造 `canRetryJob` / `resetJobForRetry`、`job-store.tsx` 的 `retryJob` 派发、`retry-job-button.tsx` 的确认弹窗、`batch-item-list.tsx` 的「未重跑」标注与 i18n（jobs cluster，en+zh）。**不动**：服务端 API 与批量数据结构、checkup 批量的重试口径、单项重试按钮（ADR-0093）、父批量的失败记录。

## Decision

1. **本轮清单由纯函数算出**：`batchRetryPlan(job)` 返回 `{ field, retry, kept, scoped }`——`field` 是 `urls`/`ns`（与 `dispatchJob` 的批量二分同口径），`retry` 是本轮要跑的项，`kept` 是已定结论、本轮跳过的项。判定「已定结论」用 `ok === true || skipped === true`（跳过不算失败，ADR-0041 决议 5）；失败项与结论丢失的占位项一律留在 `retry` 里。
2. **清单来源仍是 `urls`/`ns` 快照**：`items` 只用于判定「哪些已经有结论」，绝不当作清单反推。`items` 缺失或为空（早于 ADR-0042 的旧卡、快照被截断）时判不了成功项，`scoped=false` 退回全量——宁可重复也不漏跑失败项。
3. **只对 `batch-evaluate` 子集化**：checkup 批量维持整批重跑（约束 5）。`scoped` 标记让调用方与 UI 都能区分这两种口径，不必各自重算。
4. **成功项结论原样保留**：`resetJobForRetry` 收到 `retry` 计划时，`urls`/`ns` 收窄为本轮清单，`items` 只保留 `ok`/`skipped` 项（报告号、分数、子详情链接都还在），被跳过的键记进新字段 `retryKept`。非 `scoped` 时与旧行为逐字一致：清空 `items`、`urls`/`ns` 原样重发——ADR-0093 的否决理由就此消解，而不是被忽略。
5. **无可跑项时不提供入口**：`canRetryJob` 的批量分支改为 `batchRetryPlan(job).retry.length > 0`。全成功却因收尾故障落成 `error` 的批量卡不再显示重试按钮——重跑它没有任何收益。
6. **UI 如实说明范围**：确认弹窗在 `scoped` 且有跳过项时改用新文案（「只重跑失败或无结论的 N 项，已成功的 M 项跳过（不重复评估）」），确认按钮改「重试失败项」；子项清单对被跳过的成功项标注「未重跑」，避免它们在重试中的卡片上看起来像本轮刚跑完的。
7. **服务端零改动**：重试仍是 `POST /api/batch-evaluate`（`urls` = 失败子集），报告号由服务端照常为本轮预留；已成功项留下的报告不重生成、不重编号。失败证据在时间线里完整保留（每项一行 ✅/⚠️ 标签），新批次另起一段 `[i/n]` 计数。

## Alternatives considered

- **维持整批重跑**（现状）：实现成本为零，但 20 项死 1 项要重烧 19 次评估——这正是要解决的问题。
- **对每个失败项派发独立单任务 worker**（ADR-0093 单项按钮的批量版）：无需改动重试语义，但 N 个失败项会长出 N 张卡、N 条台账记录，父批量的失败证据反而更难对照；且丢失「一次批量、一份报告号区间」的整体性。
- **服务端补跑并反写父批量 `items`**：体验最好（父卡就地收敛成一个完整结论集），但要动批量登记表、`items` 幂等合并与跨 run 对账，ADR-0061 已列为二期成本；本 ADR 用「保留成功项 + 本轮覆盖失败项」在同一条客户端路径上拿到等价结果。
- **对 checkup 批量同样子集化**：必须接 `/api/checkup-request` 前哨并处理「同 tracker# 已在跑 → 替换面板」的裁决流，与本诉求不重合，另行立项。

## Consequences

- 重试成本从「批量大小」降到「失败项数」；已成功项的报告、tracker 行、子台账记录一概不动。
- 卡片同时承载两轮结论：保留的成功项带「未重跑」标注，本轮跑出的项正常显示。批次摘要（`n 项 · x 成功 · y 失败`）按全量计数，`[i/n]` 进度行是本轮条数——两者口径不同且都如实，不做归一化。
- 全部成功但批次落成 `error` 的卡不能再重试；用户若确需重跑，走单项重试按钮（ADR-0093）或重新派发。
- `Job` 新增 `retryKept?: string[]`；`resetJobForRetry` 的 `retry` 参数可选，既有调用点（无计划 = 整批重跑）行为不变。
- 报告号：本轮只消耗失败项个数的新号，服务端预分配逻辑未改。

## References

- ADR-0061（工作器任务重试；本 ADR 修订其「批量已成功项接受重复执行」的语义）
- ADR-0093（失败子项的单项重试；其 Alternatives 中「失败子集塞回父卡」的否决由本 ADR 正面解决）
- ADR-0041/0042/0045/0046（批量逐项结论、登记表、子任务台账、子项卡片）
- `web/src/lib/job-retry.mjs`、`web/src/components/jobs/job-store.tsx`、`web/src/components/jobs/retry-job-button.tsx`、`web/src/components/jobs/batch-item-list.tsx`、`web/src/lib/i18n/clusters/jobs.ts`
- 验证：`node --test web/tests/lib/job-retry.test.mjs`（`batchRetryPlan` / scoped reset / 全成功不可重试）；`web` 全量 `node --test` 与 `tsc --noEmit` 干净
