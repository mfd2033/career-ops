# ADR-0012: 追踪器表格列头固定（sticky thead）

- **Status:** Accepted (2026-09-10)
- **Context:** ADR-0011 已将 `/pipeline` 整页定高，追踪器表格在 `md:overflow-y-auto` 容器内独立纵向滚动。但列头（`thead`）作为表格首行，随行一起向上滚出视口，长列表滚动后用户失去列含义参照。收件箱无列头（卡片列表），其 FacetChips/批量头/批量条已在 ADR-0011 中 `md:shrink-0` 固定，无需处理。

## Decision

1. **仅追踪器 thead 加 `sticky top-0 z-10`**：表格仍在原滚动容器内（`overflow-x-auto md:overflow-y-auto`，[pipeline-view.tsx](file:///d:/workspace_opencode/career-ops/web/src/components/pipeline-view.tsx#L341)），thead 随纵向滚动吸附容器顶，行从底下滚过。不横向冻结任何列。
2. **实底背景 `bg-surface` + `border-b border-border`**：行会从 sticky 列头底下经过，需不透明背景遮住下方行；替换原半透明 `bg-surface/60`，并加底边作列头分隔。
3. **仅纵向固定**：不冻结首列（checkbox/公司），横滚时列头随 x 正常移动 —— 与「列头不纵向滚」诉求不冲突，属另一件事，本次不做。

## Alternatives considered

- **半透明玻璃感列头**（保留 `bg-surface/60`）：轻量但下方行隐约透出，阅读干扰，弃用。
- **首列横向冻结**（sticky left）：满足宽表横滚场景但越过本次纵向诉求、实现复杂（需左右偏移协调），弃用。

## Consequences

- 追踪器表格纵向滚动时列头固定，列名持续可见。
- 实现仅一个 `<thead>` 的类名改动，无数据契约/后端影响。
- sticky 依赖最近的 `overflow-y` 滚动祖先（即 ADR-0011 引入的滚动容器），两者耦合；若将来容器结构变化需同步校验。