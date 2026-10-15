# ADR-0075: 报告页新增「记录跟进」入口（复用跟进弹窗；判定与联系人取 core 同源输出）

## 状态

Accepted (2026-10-15)

## 背景

需求：在报告页（管道详情）直接记录一次跟进，不必先跳到 `/followups`。今天 `LogDialog` 与写入端点都只挂在跟进追踪器页，记录一次跟进被迫换上下文。

既有事实与约束：

1. **可复用面已存在，写路径无需新增**：`LogDialog`（`web/src/components/followups/log-dialog.tsx`；日期 / 渠道（白名单在 `followup-channel.mjs`）/ 联系人 / 备注四字段）与 `POST /api/followups/log`（进程内队列 + 跨进程文件锁 `withFollowupsWrite`，追加写 `data/follow-ups.md`，绝不清空）。失败语义是「弹窗保持打开并显示错误」。
2. **可跟进口径的真值在 core**：`followup-cadence.mjs` 的 `ACTIONABLE_STATUSES = ['applied','responded','interview']`——经 `tracker-utils` 的 `foldStatusInput` 派生自 `templates/states.yml`，只有落在其中的行会出现在跟进追踪器。联系人建议来自同一份输出的 `extractContacts(row.notes)`（对 tracker 备注的解析）。web 侧再复制一份集合或解析器，就是仓库已反复修过的「多份状态字典互相漂移」类缺陷（#2704、#2369），本次从源头避免。
3. **按钮宿主的既有口径（ADR-0032）**：操作区按钮的宿主 = 一切渲染 `ReportView` 的路由（今为 `/pipeline/{n}` 与 `/report/{n}`），由 `web/tests/lib/report-route-parity.test.mjs` 自动发现路由、断言必传 props 不漏。上一枚体检按钮正是因「只挂一条路由」发生过真实缺陷（工作器 `#N` 落到 `/report/{n}` 就找不到按钮）。
4. **详情页动作区的反馈惯例**：重新评估 / 体检 / 跳过等动作都有可见的即时反馈；跟进弹窗在 `/followups` 的「已生效」信号来自列表 refetch，而报告页没有任何跟进展示可刷新——成功时需要一个替代信号。
5. **跟进追踪器的口径就是本功能的门**：两轮 grill（2026-10-15）拍定入口仅出现在「能被记录跟进」的行上；「可跟进」= 核心输出里存在本行 entry，与跟进追踪器完全同一集合，不另立第二套判定。
6. 两轮 grill 拍定的其余边界：入口仅详情操作区（列表行不加）；只做「记录」（不做展示 / 编辑 / 删除 / 历史）；不联动投递状态与备注；弹窗原样复用、联系人建议保留且与判定同源；成功后关闭 + 页内轻提示。

## 决策

1. **入口宿主 = 一切渲染 `ReportView` 的路由**（`/pipeline/{n}` 与 `/report/{n}`），与 ADR-0032 同口径：两条路由都调用同一个 server helper 装配数据、把结果作为 props 传给 `ReportView`；`report-route-parity` 守卫的 `REQUIRED_PROPS` 扩展到新 props（漏传即红）。
2. **可判定性 = core 输出里存在本行 entry**：入口显示当且仅当 `followup-cadence.mjs --json` 的 `entries` 里存在 `num === 本行`（tracker#）的条目。判定不落在 web 侧状态集合上——「与跟进口径一致」由构造保证。core 不可用 / 解析失败 → 入口隐藏（fail-closed，不阻断阅读）。
3. **联系人建议与预填同源**：弹窗 `entry.contacts` 即该条 entry 的 `extractContacts` 输出；弹窗组件原样复用，不做报告页专属变体、不改弹窗行为。
4. **写路径复用**：提交继续走 `POST /api/followups/log`——队列、文件锁、原子写、错误语义（409 busy / 失败留在弹窗）全部继承，本次不新增任何写入面。
5. **成功后：关闭 + 页内轻提示「已记录」**（5 秒自动消失，复制收件箱 toast 模式）；失败保持弹窗打开显示错误（现状不变）。
6. **不联动**：不触碰投递状态、不写 tracker 备注。
7. **core 读取抽共享 server helper**：`/api/followups` 内联的「spawn `followup-cadence.mjs --json` + 解析 stdout」抽为 server 共享模块（归 `web/src/lib/followups-server.ts` 一族），路由与两条报告页共用；stdout→JSON 的解析抽纯函数，按房规（ADR-0050）由 `node --test` 门住（噪声前缀 / 坏 JSON → `available:false`）。迁移对 `/api/followups` 的行为逐项不变。

## 被拒方案

- **只挂 `/pipeline/{n}`**（否决）：同一份报告经工作器 `#N` 走 `/report/{n}` 就没有入口——ADR-0032 修过的缺陷类；parity 守卫的存在就是为了不让这种不对称再发生。
- **列表行入口**（本次外）：列表有独立的批量选择交互，与跟进动作的关系未论证；先只做详情，列表后议。
- **web 侧复制状态集合 / 联系人解析**（否决）：重复字典漂移类缺陷（#2704 实修过同一形状）；判定与联系人直接吃 core 输出。
- **报告页专属弹窗变体**（否决）：双份弹窗维护面翻倍，且与「体验与 /followups 一致」的拍定冲突。
- **状态 / 备注联动（含提示式）**（否决）：跟进页的既有行为是只记录；联动会把「记录」与 `set-status` 两条链路缠在一起。
- **不适用行渲染禁用态 + 说明**（否决）：动作区既有模式是「不适用即不渲染」（体检按钮同理），不新增第二种表达。
- **成功后静默关闭**（否决）：报告页没有可刷新的跟进视图，静默会让「是否存上」变成猜谜；轻提示是页面级最小反馈。

## 后果

- 正面：任意报告页可就地记录跟进；判定 / 联系人 / 写入三条都是既有唯一真值路径，不新增数据源与写面；记录结果自动流进跟进排程（如实反映在跟进追踪器）。
- 代价一：报告页每次加载多一次 core 运行（本地进程；与 `/followups`、首页跟进卡片同模式。若日后成为负担，缓存是独立增量）。
- 代价二：`ReportView` 契约再加一组 props，parity 守卫的覆盖面随之扩大——刻意选择：静默漏传没有第二次机会。
- 已知边界：core 不可用 → 入口隐藏（fail-closed）；页面打开后行状态变化要到下次加载才反映（与既有动态页一致）。
- 回滚：入口与提示是 `ReportView` 层增量，可独立退回；helper 抽取可反向内联，`/api/followups` 行为不变。

## References

- 宿主口径与守卫：`docs/adr/0032-checkup-button-on-report-page.md`（按钮宿主 = 一切 `ReportView` 路由；parity 守卫先红后绿的先例）
- 房规：`docs/adr/0050-toolbar-connection-status-badge.md`（纯模块 + node 单测）
- 判定与联系人真值：`followup-cadence.mjs`（`ACTIONABLE_STATUSES`、`extractContacts`）、`tracker-utils.mjs`（`templates/states.yml` 派生）
- 写路径与锁：`web/src/lib/followups-server.ts`、`web/src/app/api/followups/log/route.ts`
- 术语：`GLOSSARY.md` 新增「可跟进状态」
- 工单：`.scratch/followup-log-on-report-page/issues/01–03`
