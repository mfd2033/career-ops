# ADR-0019: 详情页「返回」跟随会话历史——工作器详情页不是管道页

- **Status:** Accepted (2026-09-12)
- **Context:** 详情页左上角的「返回」原本写死目标：报告页（`/pipeline/{n}`，report-view）回 `/pipeline` 并带列表上下文；工作器详情页（`/jobs/{id}`）更是两处 `Link href="/pipeline"`、按钮还自称「求职管道」（`jobs.pipeline`）。但 `/jobs/{id}` 的入口不止管道——探索页、收件箱、工作器历史、助手控制台都能进来，从这些入口点「返回」却被送去管道页，方向本身就是错的。ADR-0018 已把「工作器详情页被误当成流水线页面」定性为设计反复误判的根源（CONTEXT.md「工作器」词条的 _Avoid_ 亦然）；写死的返回链接是同一混淆残留在导航上的最后一处。

## Decision

1. **返回跟随会话历史**（Q2/Q3）。`goBackOr`（`web/src/lib/nav-history.ts`）统一实现：`prevNavHistory()` 有值且 `window.history.length > 1` → `router.back()`（保留上一页的滚动/筛选状态）；否则 `router.replace` 到前一页，无前一页时到调用方给的兜底路由。
2. **历史深度守卫**（Q3）。Chrome 会把 sessionStorage 复制给 `target="_blank"` 新标签页，应用内栈可能有「前一页」而浏览器历史没有后退项，`back()` 静默无效。`history.length > 1` 才信任 back()；报告页先例（report-view 内联的 `if (prev) router.back()`）一并补上同一守卫，两个详情页共用一套决策，不修一处漏一处。
3. **决策逻辑落纯 .mjs + 测试**（房规，同 ADR-0018 对 `report-num.mjs` 的处理）。`backNavPlan`（`web/src/lib/nav-back.mjs`）是纯函数，配 `web/tests/lib/nav-back.test.mjs`；`nav-history.ts` 只负责读栈与执行。
4. **工作器详情页的兜底是 `/jobs`，不是 `/pipeline`**（Q1）。直接打开/新标签/刷新后无应用内前一页时，工作器的自然归宿是工作器历史列表；管道页与工作器是两个概念。报告页兜底维持 `/pipeline` + 列表上下文不变（报告本就是管道行的产物）。
5. **文案通用化**（Q2）。新增 `shared.back`（「返回/Back」），两个详情页共用；`jobs.pipeline` 与 `pipeline.report.backToPipeline` 两个 key 随之删除——返回目的地已由会话历史决定，按钮文案不再指名任何页面。

## Alternatives considered

- **工作器详情页兜底也回 `/pipeline`**（Q1 否决）：与报告页先例一致，但把"工作器详情页≈管道页"的混淆又写回导航；`/jobs`（工作器历史）才是这页的列表语境。
- **动态按前一页显示目标文案**（Q2 否决）：每个来源路由都要映射一份文案，i18n 成本随入口数量增长；通用「返回」永不撒谎。
- **`router.replace(prev)` 取代 `back()`**：确定性更强，但失去 Next 对 back/forward 的滚动恢复；确定性的价值只在"浏览器历史不可信"的守卫分支里，那里本来就只能 replace。

## Consequences

- `/jobs/{id}`（含 not-found 分支）与 `/pipeline/{n}` 的返回行为一致：能回就精确回到进入前的页面，不能回则各归各的列表页。
- `jobs.pipeline`、`pipeline.report.backToPipeline` 两个 i18n key 移除；任何新详情页的返回都应复用 `goBackOr`，不要内联 if/else——守卫逻辑只此一份。
- `pushNavHistory`（AppShell 的既有机制，sessionStorage 会话栈）从"报告页专用"升格为全站详情页返回的基础设施；浏览器原生后退与站内返回从此语义一致。
