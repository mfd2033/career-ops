# ADR-0010: Inbox 批量分流（未评分过滤 + 全选 + 批量保存/跳过）

- **Status:** Accepted (2026-09-10)
- **Context:** web 端求职管道收件箱 triage 页只支持逐行 checkbox 多选和单条跳过，缺少三件高频批量操作：只看未评分、全选、批量跳过。用户在快速分流海量收件（先看"还剩哪些没评"，再一键批量保存/跳过）时需反复手点，短路了「Abundance → Triage → Shortlist」的漏斗语义。收件箱是纯客户端 triage 表面：shortlist/hidden/selected 全在 localStorage，评分不在收件箱发生（只读显示 tracker 持久分 + 本会话 live 分）。

## Decision

1. **"只看未评分"作为免费 facet**，落在 `FacetChips` 的 toggle pill（与 sources/seniority 同语言），纳入 `anyFacet` 与「清空」按钮。判定与行级 `evaluated` 同源：`resolveRowScore(live, persisted)` 返回 `running || score != null` 即视为已评分，否则未评分 —— 单一判定函数，列表过滤与行徽标永不分叉。
   - 理由：与现有 facets 一致的免费、零 token 交互；复用行级判定避免引入第二套"已评分"定义。
   - 代价：`unscoredOnly` 使 `anyFacet` 为真 → 激活时列表不截断（显示全部匹配），与其它 facet 行为一致且贴合"看全未评"。

2. **全选作用于"当前筛选后全部结果"**（`filtered`），非默认 20 条切片；按钮 toggle「全选/取消全选」。顶栏操作栏已有 N 已选计数兜底。
   - 理由：配合「未评分 → 全选 → 批量跳过/保存」流，一次覆盖全部匹配，避免每 20 条重复操作。筛选后结果是该流自然的操作单元。
   - 代价：全选含未显示的 match → 依赖操作栏 N 计数反馈 + 可一键取消。

3. **批量跳过**：把选中的 url 一次性并入 `hidden`，聚合 `undo` 一次恢复全部（与单条 skip 的 undo toast 同机制）。跳过不触碰 shortlist（与单条跳过语义一致，二者正交）。

4. **批量保存沿用现有 `saveSelected`**（只加未 shortlisted，跳过已在清单的）；批量操作全部纯客户端 localStorage，**零后端改动**。

## Alternatives considered

- **只全选当前可见行（20 条）**：更保守但批量值有限，反复操作，放弃。
- **running 中职位算"未评分"**：评分中职位已被投递 LLM，混入"待评"列表搅乱视野，令画笔更强，弃用。
- **批量跳过不做聚合 undo**：与单条跳过可撤销行为不一致，误批无退路，弃用。

## Consequences

- 用户可一条流完成"只看未评分 → 全选 → 批量跳过残次 / 批量保存候选"。
- 纯客户端，无数据契约与后端影响；i18n 新增 5 键（en/zh 对称）。
- 判定函数 `isEvaluatedRow` 与 TriageRow 的 evaluated 逻辑保持单一来源，两者永不打架。
- `unscoredOnly` 激活时列表不截断（同其它 facet），全选范围随之扩大 —— 用户需依操作栏计数确认。