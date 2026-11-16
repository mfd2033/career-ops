# ADR-0102: 跟进时机——复用投递矩阵，跟进页/今日页行级提示（fork-local）

## 状态

Accepted (2026-11-16)

## 背景

ADR-0085 把三平台黄金时段矩阵做成了投递决策点的只读提示。用户 2026-11-16 提出给跟进功能加同样的时机提示：跟进消息也要挑黄金时段发。目的和投递不同，投递拼的是先发优势，跟进拼的是回复率。

同日两条用户决策框定了问题边界：

1. **跟进只在招聘平台的沟通工具内进行**（Boss 直聊、猎聘/智联站内信）。`followup-channel.mjs` 的 `Platform` 渠道本就是默认主渠道（2026-09-28 决策），三平台矩阵全覆盖，之前担心的「邮件/LinkedIn 渠道不在矩阵内」不成立。
2. **所有涉及跟进功能的页面都要能看到跟进时机**，包括但不限于跟进页、今日页。

既有事实与约束：

1. **引擎已存在且是纯函数**：`delivery-window.mjs` 的 `windowAt` / `nextWindow` 回答的就是「招聘者什么时候在看消息」。跟进消息的受众和投递相同：同一个 HR、同一个渠道，矩阵直接适用。
2. **跟进数据里没有职位 URL**：`CadenceEntry`（`web/src/lib/followups.ts`）只有 `num` / `reportPath`；但 `followups-server.ts` 的 `readFollowupScripts()` 已有 `readApplicationUrl(app)` 按 tracker 行号读报告头 URL 的先例（ADR-0081），链路现成。
3. **来源平台还原已有单点**：`source-label.mjs` 的 `sourcePlatform(url)`，与管道页「来源」列、投递时机行级列同一张域名表。
4. **挂载点盘点（2026-11-16 代码探索）**：跟进信息出现在三处，分别是 `/followups`（`FollowupsView` 表格行）、今日页（`TodayDashboard`「待跟进」区的 `FollowUpCard` 卡片）、报告详情页（`ReportView` 操作排的跟进按钮）。`/pipeline` 列表无跟进内容，agent-inbox 与跟进无关，均排除。
5. **报告详情页已有单平台 `DeliveryTimeHint`**：同矩阵、同平台，跟进与投递在该页的结论必然相同。
6. **组件无测试面（ADR-0077 约束）**：可测逻辑全部在既有纯 `.mjs` 里，本轮新增的只有服务端字段装配与 UI 接线。
7. **矩阵语义有一处未验证假设**：Boss 是直聊模式、矩阵含晚间高峰，对站内沟通直接适用；猎聘/智联矩阵的语义是「投递被 HR 筛看」的时段，站内信被查看的时段大概率一致但未经验证。

## 决策

1. **复用 `delivery-window.mjs`，不建第二份矩阵**。等级（best/ok/avoid）、判定、配色口径与投递完全一致；引擎注释声明的「招聘者活跃度」语义对跟进同样成立。
2. **数据链路：`/api/followups` 的 `CadenceEntry` 新增 `postingUrl` 字段**。服务端按 `num` 读 tracker 行报告头 URL（复用 `readApplicationUrl` 模式，仅 http(s)），客户端经 `sourcePlatform(postingUrl)` 还原平台。报告详情页直接用组件作用域里已有的 `app.url`，不走新字段。
3. **挂载点：两处新增 + 一处沿用**。
   - `/followups` 表格新增「跟进时机」列，紧随沉默/冻结列、操作区之前，发跟进的动作就发生在行尾操作区，时机要贴着它。形态照抄 ADR-0085 修订 2026-10-26 的 `/pipeline` 行级「投递时机」列：纯展示、不参与排序（实时时钟量，排序无意义）、等级徽章复用 `LEVEL_TONE`、时钟只在浏览器算（SSR 首帧 `now=null` 显「—」占位防 hydration 抖动，30 秒重算）、非三平台来源或拿不到 `postingUrl` 显「—」并悬停如实说明。
   - 今日页 `FollowUpCard` 在操作区左侧加一枚同款徽章（平台名 + 等级词）；来源不可识别时显 muted「—」加悬停说明，不静默消失（ADR-0085 被拒方案 4 的理由同样适用）。
   - 报告详情页沿用既有单平台 `DeliveryTimeHint`，不新增第二条：同矩阵同平台同结论，重复挂载是把同一句话说两遍；悬停 title 文案补充「该结论同时适用于投递与跟进消息」。
4. **只读提示，不触发任何写操作、不自动定时发送**：沿用 ADR-0085 决策 6。
5. **判定不看渠道字段**：用户已明确只在平台内沟通，按渠道分叉只会让大部分行掉进「无规律」；统一按职位来源平台判定。
6. **i18n**：新键收进 `clusters/followups.ts`（`followups.timing.*`），等级词与平台名复用 `clusters/delivery.ts` 既有键，en/zh 同序，不建第二份文案。
7. **零新增纯函数**：等级计算、平台还原全是既有引擎；新增的只有 `postingUrl` 的服务端装配与三处接线。

## 被拒方案

- **`/followups` 页头再挂一条三平台常驻条**（否决）：行级列已逐行给出结论，页头条与之同屏重复。ADR-0085 的页头条在管道页成立，是因为那里的决策是「今天投哪些」的批量跨平台视角；跟进页的决策点是「这一行现在发不发」，行级就够。
- **新建 `followup-window.mjs`**（否决）：第二份矩阵必然口径分叉；跟进与投递面对的是同一批招聘者。
- **按渠道字段分叉判定**（否决）：Email/LinkedIn 等渠道确实不在矩阵内，但用户明确不走这些渠道；为不存在的路径引入分叉是无用复杂度。
- **报告页新增跟进时机条**（否决）：与既有投递时机条同矩阵同平台，结论必然相同。
- **客户端逐条取 postingUrl（复用 `/api/followups/scripts?num=N`）**（否决）：跟进页与今日页都是 N 条列表，N+1 请求不可接受；服务端在 `/api/followups` 批量装配一次到位。
- **把 postingUrl 持久化进 `data/follow-ups.md` 或 tracker 行**（否决）：URL 已是 tracker 行报告头的事实，再存一份就是第二事实源；按 `num` 现读即准。
- **今日卡片来源不可识别时静默不渲染徽章**（否决）：隐藏会让人以为功能坏了；改为一枚 muted「—」加悬停说明。
- **浏览器扩展内加跟进时机提示**（本轮否决，记为后续候选）：自动跟进确实受时机影响，但扩展与 web 不同栈，本轮只覆盖 web 三处挂载；待 web 版观察有效后再议。

## 后果

- 正面：跟进「几点发」在跟进页、今日页抬头一眼；零新增引擎、零新增依赖、零新增写面。
- 代价一：`CadenceEntry` 加字段，旧引擎 JSON 无 `postingUrl` → `undefined`，UI 与「来源不在三平台」走同一条「—」路径，不报错。
- 代价二：猎聘/智联站内信时段是假设（矩阵语义原为投递筛看），观察不符时需单独调表——ADR-0085 的矩阵维护代价在这里延续。
- 已知边界：浏览器扩展内的自动跟进无时机提示，本轮范围外。
- 回滚：删两处挂载 + API 字段 + i18n 键即回原状，无数据迁移。

## References

- ADR-0085（投递时机：引擎、等级色、行级列形态、槽位原则、诚实降级原则）
- ADR-0075 / ADR-0079 / ADR-0081（跟进日志入口、冻结建议、打开职位链接）
- 引擎：`web/src/lib/delivery-window.mjs`；等级色：`web/src/components/delivery-tone.ts`
- 来源平台还原：`web/src/lib/source-label.mjs` `sourcePlatform()`
- 跟进数据：`web/src/lib/followups.ts`（`CadenceEntry`）、`web/src/lib/followups-server.ts`（`readApplicationUrl` 先例）
- 挂载点：`web/src/components/followups/followups-view.tsx`、`web/src/components/home/follow-up-card.tsx`、`web/src/components/report-view.tsx`
