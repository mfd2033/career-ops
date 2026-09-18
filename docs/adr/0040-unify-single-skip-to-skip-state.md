# ADR-0040: 报告页单个「跳过」按钮与批量跳过统一写 SKIP

- **Status:** Accepted (2026-09-18)
- **Context:** ADR-0038 把「跳过」拆成两个落点：管道已评估 tab 的**批量**跳过写 `SKIP` 终态（独立「跳过」tab），而报告页**单个**跳过按钮（`SkipFromTracker`）写 `Discarded`（已放弃）。两个按钮都叫「跳过」，但落点不同——用户（2026-09-18）实测报告页点「跳过」后状态下拉框显示「已放弃」、行落入已放弃 tab，认为同名词不同落点是体验坑，明确要求按方案 1 统一：**单个跳过也写 `SKIP`**。约束：
  1. `SKIP` 与 `Discarded` 都是 `templates/states.yml` 终态（terminal: true），`Evaluated → SKIP` 是合法前向迁移（ADR-0038 已验证批量路径）。
  2. 单按钮契约是 `/api/status` → `set-status.mjs`（写锁 + states.yml 校验 + status-log.tsv），只改请求体里的目标状态，写门不变。
  3. 报告页在 `app.status !== "Discarded"` 时渲染跳过按钮（`report-view.tsx`），统一后该守卫条件需同步改为排除 SKIP，否则已跳过的报告仍显示按钮。
  4. 语义随写盘值变化：「跳过」从"看过、不要（Discarded）"变为"岗位不适合、不投递（SKIP）"。今日页「Awaiting your decision」块的跳过（decision-card）与 `SkipFromTracker` 同一契约——本次一并统一，否则今日页与报告页又分裂。
  5. CONTEXT.md「跳过（skip）」词条、i18n 文案（`pipeline.skipTitle`）需同步改写，消除"动作 Discarded vs 状态 SKIP"的旧区分描述。
  6. 落点决策（skip-destination.mjs：下一份/列表页/首页三档）与写盘状态无关，不动。

- **Scope:** `web/src/components/skip-from-tracker.tsx`（fetch body `Discarded` → `SKIP`）、`web/src/components/report-view.tsx`（守卫条件）、今日页 decision-card 的跳过动作（同契约处）、`web/src/lib/i18n/clusters/pipeline.ts`（`pipeline.skipTitle` 等文案）、`CONTEXT.md` 跳过词条、`docs/adr/0038` Consequences 末段标注被本 ADR 修订。回归测试：`web/tests/lib/skip-destination.test.mjs` 不受影响（落点纯函数）；新增/调整断言覆盖「跳过写 SKIP」的契约（组件层以代码审查 + 手动验证为准，无现成组件测试 seam 则如实记录）。

## Decision

1. **统一写 `SKIP`**：`SkipFromTracker` 的 `/api/status` 请求体从 `status: "Discarded"` 改为 `status: "SKIP"`。报告页跳过与管道批量跳过（ADR-0038）落点一致，均归入「跳过」tab。
2. **今日页跳过同契约统一**：今日页「Awaiting your decision」的跳过与 `SkipFromTracker` 共用组件/同一请求体（代码注释声明同一契约），跟随改动，不再分裂。
3. **守卫同步**：报告页跳过按钮的渲染条件从 `status !== "Discarded"` 改为 `status !== "SKIP"`（已跳过的报告不再显示按钮；状态可经下拉框手改）。
4. **文案同步**：`pipeline.skipTitle` 改为「将此岗位标记为跳过（SKIP）——归入跳过分组」语义；中文 cluster 同步。不再出现「跳过=已放弃」的旧表述。
5. **文档同步**：CONTEXT.md 跳过词条重写（单一落点 SKIP，移除动作/状态二分描述）；ADR-0038 Consequences 末段补一行「ADR-0040 起单按钮也写 SKIP，本条区分不再成立」。

## Alternatives considered

- **维持现状、只改文案**（方案 2）：单按钮改叫「放弃」。用户已选方案 1——按钮名词面统一、落点也统一，避免用户记忆两个语义。
- **单按钮写 Discarded 但加确认弹窗**：没解决落点分裂，只是降低误触代价；用户已否。
- **新开中间状态（如 Skipped 非终态）**：states.yml 加新状态牵动 writer/reader 双端与 tracker-sync-check，成本远超诉求；SKIP 终态已存在且语义贴切。

## Consequences

- 两个「跳过」入口（报告页单个、管道批量）落点一致：都写 `SKIP`，行归入「跳过」tab。
- `Discarded`（已放弃）回归纯状态语义：只能经状态下拉框手写或既有历史数据，不再被「跳过」按钮产生。
- 历史数据不受影响：此前经单按钮写入的 Discarded 行留在已放弃 tab（终态迁移不做数据迁移）。
- status-log.tsv 会记录 `Evaluated → SKIP` 的转换（source 来自 web 写门），与批量跳过同构。

## References

- ADR-0038（批量跳过写 SKIP 的先例与「两落点」区分的出处）。
- `templates/states.yml`（`skip` / `discarded` 均为终态）。
- `web/src/components/skip-from-tracker.tsx`、`web/src/components/report-view.tsx`、`web/src/app/api/status/route.ts` + `set-status.mjs`。
- CONTEXT.md「跳过（skip）」词条。
