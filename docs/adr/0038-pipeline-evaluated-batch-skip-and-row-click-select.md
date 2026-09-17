# ADR-0038: 管道已评估页批量跳过 + 列表行点击选中

- **Status:** Accepted (2026-09-18)
- **Context:** 需求（2026-09-18）：①在「已评估」页增加批量跳过功能；②列表项点击复选框之外的空白区域也能选中。现状与约束：

  1. **管道追踪器表已有「批量重评估」条**（`pipeline-view.tsx`）：勾选集以 tracker `#`（`r.n`）为键，全选/部分选按当前可见筛选行计算；选中集跨 tab 保留（`selected` 是组件级 `Set`，切 tab 不清）。
  2. **CONTEXT.md「跳过（skip）」词条已区分两种「跳过」**：报告页「跳过」动作 = 标记已放弃（**Discarded**），是动作不是状态；tracker 终态 **SKIP**（"不在考虑范围/不投递"，独立 tab）是另一概念，两者不可互推。现有单个跳过按钮（`SkipFromTracker`）写的正是 Discarded，且**无确认弹窗**。本 ADR 决议把**批量**跳过改为写 `SKIP`（与单按钮分离，落点不同）。
  3. **行内公司名 / 职位 / 分数三个单元格都是 `<Link>` 跳详情页**，整行此前无 `onClick`。要让空白区点击选中，必须让这些链接与复选框在点击时既不被行点击劫持、也不触发误选中。
  4. **写状态走 `/api/status` → `set-status.mjs`**：持 tracker 写锁、校验 `templates/states.yml`、追加 `status-log.tsv`。`Discarded` 是终态；从 `Evaluated`（已评估 tab 的全部行）写入是合法的前向迁移。

- **Scope:** web 层——`pipeline-view.tsx` 批量条新增跳过按钮（仅已评估 tab）、`<tr>` 点击切换选中 + 复选框单元格与三个 Link 单元格 `stopPropagation`、`i18n` 三键、`CONTEXT.md` 词条补一句。**不动**：`set-status.mjs` / `/api/status`、`SKIP` 终态、单个跳过按钮（`SkipFromTracker`）行为、其他 tab 的批量条。

## Decision

1. **批量跳过写 `SKIP`（跳过分组，终态）**：用户明确「跳过」应落到 canonical `SKIP` 状态（`states.yml` id `skip`，"don't apply"，独立 跳过 tab），而非 `Discarded`。行仍在 tracker、移出已评估队列、归入跳过分组、可经筛选找回。与报告页单个跳过写 `Discarded` 不同——两者都叫「跳过」但落点不同（CONTEXT.md「跳过」词条已区分动作 / 状态）。
2. **批量跳过按钮仅当 `tab === "EVALUATED"` 时出现在批量条**，与需求字面"已评估页面"一致；其他 tab 批量条保持原样（重评估照旧）。按钮用静音 / 红边样式区别于重评估的品牌色，暗示终态。
3. **行点击选中**：`<tr>` 加 `onClick` 切换选中（`cursor-pointer` 提示可点）；复选框所在 `<td>` 与三个 Link 单元格（公司 / 职位 / 分数）加 `onClick stopPropagation`——点击链接仍正常导航、点击复选框仍由自身 `onChange` 切换（单元格阻止冒泡，不与行点击双重切换），二者都不会误触发选中。选中集语义不变（仍以 `r.n` 为键、跨 tab 保留）。
4. **批量跳过的 blast radius 给一次确认**：`window.confirm` 显示将跳过的条数（一次性动几十条的终态、无 UI 一键撤销）。单个跳过维持无确认，与现有行为一致。
5. **批量写实现**：对选中集**顺序** `POST /api/status {n, status:"Discarded"}`（不用并发，避免抢 tracker 锁返回 503）；全部发完后 `router.refresh()` 重读并清空选中。单条失败不阻断后续、不中途停。

## Alternatives considered

- **写 `SKIP` 终态**：语义是"不在考虑范围"，与现有单按钮（写 Discarded）分裂；用户已选 Discarded。
- **整行任意位置点击都切换（含链接）**：牺牲原地点击进详情，导航需改新标签 / 右键，代价大；用户已选"链接照跳"。
- **仅复选框格切换**：最保守，但"空白区域"诉求没满足；用户已选空白区切换。
- **批量不确认**：与单按钮一致，但几十条的终态误触代价大；用户已选批量确认。
- **并发 POST 批量跳过**：会抢锁 503，需重试逻辑；顺序实现更简单且对锁友好。

## Consequences

- 已评估页批量条多一个「跳过 N 项」动作，与「重新评估 N 项」并存。
- 列表行整体可点选，多选效率提升；链接导航、复选框切换均不受影响。
- 跳过是终态、无 UI 一键撤销（靠筛选 / 找回）；批量多一层确认降低误触代价。
- 选中集跨 tab 保留的旧行为不变；批量跳过按钮只在已评估 tab 可见，但勾选动作本身不限制 tab——切回已评估才会露出按钮，符合"已评估页面"的语境。
- **批量跳过（SKIP）与报告页单个跳过（Discarded）是两个不同落点**——都叫「跳过」，语义不同（动作 vs 状态，CONTEXT.md 词条）。本次只改批量路径，未动 `SkipFromTracker`；若日后要统一，需另改该组件（不在本 ADR 作用范围）。

## References

- CONTEXT.md「跳过（skip）」词条（动作 Discarded vs 状态 SKIP 的区分）。
- `web/src/components/skip-from-tracker.tsx`（单个跳过写 Discarded 的先例）。
- `web/src/app/api/status/route.ts` + `set-status.mjs`（写门与锁）。
- ADR-0037（管道表列 / 排序，同组件上下文）。
