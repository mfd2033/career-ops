# ADR-0062: 管道追踪器表唯一导航入口 = 公司名（收掉职位/分数列跳转）

- **Status:** Accepted (2026-09-25)
- **Context:** 需求（2026-09-25，四轮 grilling 敲定）：`/pipeline` 追踪器表（全部 / 已评估 / 跳过等所有非 INBOX tab）里，只有点击公司名才跳报告详情页；职位列与分数列不再导航。现状与约束：

  1. **一行有三个站内链接**：公司名（含 logo）与职位都是 `<Link href="/pipeline/{n}{contextQuery}">`，分数徽章是 `<Link href="/report/{n}">`（ADR-0016 的「直跳报告」通道）；行空白区是 `<tr onClick>` = 切换批量勾选，三格靠 `stopPropagation` 不被行点击劫持（ADR-0038 决议 3 明写「三个 Link 单元格」）。
  2. **痛点是误触，不是语义重复**：用户诉求明确选「想勾选行做批量，结果误点职位/分数跳走了页面」——跳走会丢列表的筛选与滚动位置。这决定了方案是**去掉链接本身**，而不是给链接换去向。
  3. **`/pipeline/{n}` 与 `/report/{n}` 渲染同一个 `ReportView`**（ADR-0032 决议 1 把按钮宿主定为「一切渲染 `ReportView` 的路由」），视觉几乎等价，只差别名页无 prev/next 报告导航与评估用时面板。因此用户把两者都称作「报告详情页」，砍掉分数链**不等于**砍掉报告的可达性。
  4. **体检★ 与「建议体检」两枚角标嵌在公司 `<Link>` 内部**（带 `stopPropagation` + `cursor-help` 悬停提示，ADR-0026/0041），是全行唯一挂在导航链接里的非文本元素，去链方案必须单独安置它们。
  5. **无测试断言职位/分数格是链接**（核实：`web/tests/` 下只有 `unknown-employer-policy.test.mjs` 读 `pipeline-view.tsx` 源码，断言的是匿名雇主 label 接线）。不写守卫的话，下次有人「为了方便」把链接加回去毫无拦截。
  6. **`/report/{n}` 还有一批入口在列表之外**：扩展深链（ADR-0002/0055）与工作器 `#N`（`ReportNumLink`，ADR-0018），与本件无关、不触碰。
  7. **改动面天然只在 `web/`**：`dashboard-ui/` 无同类列表链接（核实零命中）。

- **Scope:** web 层单文件——`pipeline-view.tsx` 行内链接结构 + 新增源码守卫单测 + 本 ADR。**不动**：收件箱 triage 行（ADR-0060）、探索候选清单、`/jobs` 列表、`/report/{n}` 与 `/pipeline/{n}` 两条路由本身、`row-click.mjs`、批量条与选中集语义（ADR-0038/0039）、数据层与 `set-status.mjs`。

## Decision

1. **唯一站内导航入口 = 公司名**（含 logo），目标维持 `/pipeline/{n}` + `contextQuery`——tab/sort/dir/q 上下文与 ADR-0036 的 prev/next 顺看能力不降级。
2. **职位列去链**：`<td>` 内改纯文本 `{r.role}`，去掉 `<Link>` 与其 `stopPropagation`，点击冒泡到 `<tr>` = 切换勾选（去链后的默认行为，零额外逻辑）。
3. **分数列去链**：裸渲染 `<Badge tone={scoreTone(r.score)}>`，去掉 `<Link>`、`stopPropagation` 以及只为链接存在的 `hover:opacity-80`；分数为「—」的行同样只是文本（原先点它会进一份没有报告正文的空详情页）。
4. **体检角标移出链接**：`<td>` 内用 flex 容器包住 `<Link>` 与角标，使两者成兄弟节点；保留 `title` 悬停提示，去掉 `onClick` 拦截 → 点角标 = 勾选，与全行一致。
5. **`/report/{n}` 在 web 侧不留替代入口**：不加详情页「纯报告视图」链接、不给表格新增报告列。该路由退化为扩展深链与工作器 `#N` 的专用落点，路由本体与 parity 守卫（`report-route-parity.test.mjs`）原样保留。
6. **热区与视觉不加补偿**：公司 `<Link>` 维持只包 logo + 公司名（单元格 padding 归勾选），不给公司名加常驻下划线、不给分数加「查看报告请点公司名」类 tooltip；`group-hover:text-brand` 与行 hover 底色沿用现状。
7. **窄屏同口径**：不加设备分支，手机与桌面一套规则（两套规则本身是新的认知负担）。
8. **不变量用源码字符串守卫测试锁定**：新增 `web/tests/lib/pipeline-single-nav-entry.test.mjs`，读 `pipeline-view.tsx` 断言 `/pipeline/${r.n}` 链接恰好出现 1 次、`/report/` 在列表组件里出现 0 次。先例：`unknown-employer-policy.test.mjs`、`report-route-parity.test.mjs` 同为不可导入的 TSX 源码守卫。
9. **a11y 本次不动**：公司链接保住键盘导航路径（可 Tab 到的链接从 3 个降到 1 个，仍完整）；「行勾选无键盘入口」是 ADR-0038 既有留白，记入本 ADR 非目标，不顺手补 `tabIndex`/Enter。
10. **落档只写本 ADR**：`CONTEXT.md` 不新增词条，`ADR-0038` 与 `ADR-0060` 原文不改写；ADR-0038 决议 3「三个 Link 单元格 stopPropagation」的表述自本 ADR 起失效，以本文为准。

## Alternatives considered

- **分数改为新标签页打开 `/report/{n}`**：保留 ADR-0016 直跳通道、且不再丢列表状态，但误触本身仍在（多出一个意外标签页），且留一条只有老用户知道的旁路。用户选彻底去链。
- **职位点击打开原职位帖**（与收件箱行标题语义对齐，ADR-0060 决议 2）：tracker 行的 posting URL 不保证存在，且给同一张表引入第三套点击语义。
- **窄屏保留职位跳转**：手机上勾选框小、进详情是高频动作——但分支规则的可维护代价高于其收益。
- **整行任意位置都跳详情、勾选退回 checkbox**：与 ADR-0038 相反，且直接违背本件痛点。
- **抽 `web/src/lib/*.mjs` 纯函数锁「哪些格子可导航」**（ADR-0055/0060 同法）：这里没有可判定的逻辑可抽，只有声明式 JSX 结构，纯函数层是过度工程；源码计数守卫足够。
- **在 ADR-0038 原地加修订注记代替新 ADR**：少一个文件，但用户选显式新 ADR（先例：ADR-0032、ADR-0040 都以新文取代旧决议）。
- **在详情页或表格补一个 `/report/{n}` 入口**：等于把刚砍掉的旁路从另一个门放回来。

## Consequences

- 行勾选热区显著扩大：除公司名与复选框外全行可点，正对误触痛点；`/report/{n}` 在 web 里再无入口（ADR-0016 的该决议在列表侧失效）。
- 表内可 Tab 到的链接从 3 个降到 1 个：键盘导航仍可达详情，行勾选仍只能鼠标（既有留白，非新增缺陷）。
- 公司单元格多一层 flex 容器以容纳出链的角标，是本次唯一的布局改动；角标外观、tooltip、`checkupTone` 取色口径均不变。
- 「只有一个导航入口」首次有了可测试缝：任何人把职位/分数改回 `<Link>` 都会让新单测变红。
- 与收件箱行的实现形状差异保留：那边是集中式 `closest('a,button,input')` 排除（ADR-0060 决议 1），这边是逐格 `stopPropagation`（现在只剩复选框格与公司链接）；互读时以各自 ADR 为准。

## References

- ADR-0038（行点击选中与「三个 Link 单元格」的原决议，本 ADR 部分推翻其决议 3）。
- ADR-0016（分数徽章直跳报告通道的来源）、ADR-0032（`ReportView` 宿主与两条路由的 parity）。
- ADR-0036 / ADR-0037（`/pipeline/{n}` 的报告导航与薪资排序，依赖 `contextQuery`，本件不改）。
- ADR-0018 / ADR-0055 / ADR-0002（`/report/{n}` 的列表之外入口：工作器 `#N` 与扩展深链）。
- ADR-0026 / ADR-0041（体检★ 与「建议体检」角标的宿主与判定口径）。
- ADR-0060（收件箱行点击，本件维持不动）。
- `web/src/components/pipeline-view.tsx`、`web/src/app/pipeline/[id]/page.tsx`、`web/src/app/report/[id]/page.tsx`、`web/tests/lib/unknown-employer-policy.test.mjs`。
- 实现工单：`.scratch/pipeline-single-nav-entry/issues/01–02`（01 = ADR + 去链接线 + 守卫测试；02 = 实机逐条取证 + 收尾提交）。
