# ADR-0032: 体检按钮的宿主 = 所有报告页——/report/{n} 不再是「纯阅读」

- **Status:** Accepted (2026-09-17)
- **Context:** 用户实测症状：从工作器任务点报告号（`/jobs` 行的 `#N`、工作器详情页子标题 `#N`、侧栏工作器卡片——三处都走 `ReportNumLink`，ADR-0018 规定一律落 `/report/{n}`），到报告页的操作区看不到「体检这家」，只能自己再手跳到 `/pipeline/{n}`。
  根因是两条决议打架：**ADR-0026 决议 2** 把按钮位置定死为「仅 `/pipeline/{n}` 行详情页，`/report/{n}` 保持纯阅读」（**ADR-0027 决议 6** 继承，明确「决议 2 继续有效」），而 **ADR-0018** 又要求工作器的报告跳转落 `/report/{n}`——于是「从工作器去体检」这条最自然的路径必然撞墙。
  而决议 2 的前提「`/report/{n}` 是纯阅读面」已不成立：该路由渲染的是**同一个 `ReportView`**，操作区里重新评估 / 申请 / 删除 / 跳过俱全，唯独体检按钮被 props 缺席挡掉（`report-view.tsx` 的 `{checkupTarget && <CheckupRequestButton …/>}`，而 `app/report/[id]/page.tsx` 从未传 `checkup` / `checkupTarget`）。
  反馈环证据（`.scratch/checkup-on-report-page/probe.mjs`，抓两条路由的 SSR HTML 数标记，agent-runnable / 秒级 / 确定性）：`#1022`（无体检记录）与 `#917`（已有体检记录）在 `/pipeline/{n}` 体检按钮 ×1、在 `/report/{n}` ×0；同排的「重新评估」两侧都是 ×1 → 操作区在渲染，缺的只是体检 props，不是布局、不是 hydration、不是 i18n。

## Decision

1. **按钮宿主 = 一切渲染 `ReportView` 的路由**（现为 `/pipeline/{n}` 与 `/report/{n}`）。判定门槛一字不变：`checkupTarget.ok`（`?` 行取报告 Via 作招聘主体，缺 Via 则禁用并给原因码）——按钮的三态（体检 / 复检 / 禁用）、`/api/checkup-request` 通路、当天去重、agent-inbox 审计行全部照旧。
2. **数据来源唯一**：两条路由各自调用 `readCheckupFor(id)` + `findCheckupTarget(id)`，判定逻辑不得复制到组件或路由里（形状单一来源仍是 `career-ops.ts` 的 `CheckupTargetResult`）。
3. **防回归 = 路由 parity 守卫**：新增 `web/tests/lib/report-route-parity.test.mjs`，自动发现 `web/src/app/**/page.tsx` 中所有渲染 `<ReportView` 的文件，断言每个都传了 `checkup` 与 `checkupTarget`。本次 bug 的可测试缝就在这里——漏传发生在**路由文件**里，不在组件里，所以守卫必须落在路由层，并且用自动发现而不是硬编码两条路径（下一个新增报告路由不会再静默漏传）。
4. **本题不改的**：ADR-0026 决议 3/4/5/6/8（★+复检、挂触发行、`?` 行取 Via、零分影响、drain 规则）与 ADR-0027 决议 1–5（worker kind=checkup、指针式 prompt、inbox 仅记审计、去重语义、旧 pending 并存）继续有效。
5. **显式非目标**：`/report/{n}` 同样缺 `EvalTimingPanel` 的同类差异本次不动。评估用时是 ADR-0016/0017 那条线的取舍（深链页保持极简），把它一起拉进来会把「扩展体检按钮」变成「重排报告页」——留待单独决定，此处只记录它是已知的同类差异。

## Alternatives considered

- **改 `/jobs` 的 `#N` 落点**（否决）：ADR-0018 把报告号定义为导航关系（「这个工作器引用了哪份报告」），按按钮可用性分流会让同一枚 `#N` 在不同上下文去不同页面，语义分裂。
- **报告页只放一条「去详情页体检」的跳转入口**（否决）：多一跳，且要用户知道两个报告路由的分工；报告页本就渲染完整操作区，这个差异零解释成本——用户实证是「就地找不到 = 没有」。
- **保留决议 2，改为在工作器侧提示「体检请去详情页」**（否决）：把 ADR 的分工概念转嫁给用户，是最贵的解释成本。

## Consequences

- 从工作器点 `#N` 落报告页即可就地派发/复检；浏览器扩展「已评估」徽章深链进来的页面同样出现按钮（同一 API、同一人在环确认；`JobsProvider` 挂在根 `layout.tsx` 的 `AppShell` 上，深链路由也能 `useJobs`）。
- **ADR-0026 决议 2 与 ADR-0027 决议 6 中「按钮仅行详情页 / `/report` 保持纯阅读」的表述被本 ADR 取代**，两条 ADR 的其余决议继续有效；`CONTEXT.md`「体检请求」词条的「行详情页」改为「报告页」。
- 「报告路由少传 props」这类静默差异首次有了可测试缝：parity 守卫在 `/report/{n}` 接线前是红的，接线后绿。
