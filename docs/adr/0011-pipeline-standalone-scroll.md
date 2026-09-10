# ADR-0011: 管道页列表独立滚动（整页定高布局）

- **Status:** Accepted (2026-09-10)
- **Context:** web 端求职管道页 `/pipeline`（`PipelineView`）当前是文档流布局——外层 `mx-auto max-w-6xl` 无高度约束，标题/搜索/tabs 与列表一起随整页滚动。用户需求：滚动列表时**只滚动列表，其它内容（标题、搜索、tabs、过滤条、批量操作栏）固定不动**。左侧栏已有 `sticky h-screen overflow-y-auto` 的独立滚动范式可参照，但主区 `main` 仍随文档滚动。

## Decision

1. **整页定高布局**（方案 a，逐字满足"只滚动列表"）：`/pipeline` 外层容器在 `md:` 及以上（≥768px，与侧栏 `md:flex` 判据一致）设为 `md:h-screen md:flex md:flex-col` —— 页面本身不再滚动，列表填满剩余空间并内部独立 `overflow-y-auto`。标题/搜索/过滤/批量操作栏一律 `md:shrink-0`，永不压缩。

2. **两个 tab 全部独立滚动**：INBOX（`InboxTriage`）与追踪器表格（ALL/各状态）同样处理。追踪器表格容器在 `overflow-x-auto`（宽表横滚）基础上叠加 `md:overflow-y-auto`（列表纵滚），上下空间由 `md:flex-1 md:min-h-0` 接管。

3. **矮视口/手机兜底**：判据用宽度断点 `md:`（768px），**不用高度 hook**。手机（<768px）保持整页自然滚动，保留 `max-sm:pb-24` 底部导航避让。理由：与侧栏判据统一、纯 CSS 零 JS 副作用；桌面矮窗口（如 800×500）会被定高压缩，但罕见，不值得为此引入 `window.innerHeight` 监听。

4. **`min-h-0` 是 flex 溢出关键**：`flex-1` 子项默认 `min-height:auto`，内容高时不会缩小、无法产生内部滚动；必须显式 `md:min-h-0`。此乃本改动的核心陷阱。

## Alternatives considered

- **sticky 顶栏**（方案 b）：tabs 固定但列表仍随整页滚动，不满足"只滚动列表"的字面诉求，弃用。
- **按视口高度 hook 兜底**：精确命中"矮"字但引入 resize 监听副作用，且与侧栏 `md:` 判据分叉，弃用。
- **整页定高应用到所有页面**：超出本次需求，仅收敛到 `/pipeline`，避免扩大影响面。

## Consequences

- `/pipeline` 桌面端：头部元素固定，长列表在页内独立滚动，不带动整页。
- 手机端行为不变（自然滚动 + 底部导航）。
- 改动集中在 `pipeline-view.tsx`（外层与追踪器分支）与 `inbox-triage.tsx`（根节点 + `ul` 列表区），无数据契约/后端/样式系统层面影响。
- 追踪器宽表在纵滚容器内保留横滚，x/y 滚动条同元素共存。