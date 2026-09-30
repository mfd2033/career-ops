# ADR-0069: 探索页 BSK 采集的逐平台进度（chip 内 n/上限）

- **Status:** Accepted (2026-09-30)
- **Context:** 需求（2026-09-30 grill 会话，两轮问答全部锁定）：「探索页用 bsk 时，在选中的平台页面显示采集进度，比如猎聘设置的 400，显示 xxx/400」。现状与约束（均经代码核实）：
  1. **BSK 扫描有两条驱动**：①扩展驱动主路径（`explore-provider.tsx::driveViaExtension`，content script 分批上报、前端 2s 轮询）；②服务端 bsk CLI 兜底（`browser-scan.ts`，每平台一个子进程、跑完才吐全量 JSON，**中途无进度可取**）。
  2. **逐平台计数其实已有两个半成品信号，都没接进 UI**：`scan-status` 每轮返回 active 平台列表（当前只用来判收尾，chip 的 active 态在浏览器模式下从未被点亮）；`/api/explore/scan-progress` 返回全局 `collected`（status 行「已采集 N 条」用它）。浏览器模式下 chip 从 queued 直接跳 swept，中间整段是死的。
  3. **分母是用户配置**：配置页 `scanMax`（猎聘默认 1200、BOSS/智联 400），发起扫描时逐 target 传给扩展；上限是**截断保护**而非目标数——平台实际供给常少于上限。
  4. **猎聘拆词**：搜索框多关键词会被 `expandSearchTargets` 拆成每词一条 URL、各自一个采集会话、各自一个上限（BOSS/智联整串一条）。
  5. **采集门在收尾才跑**：薪资/城市/标题三道门是扫描结束后在前端一次性套用（ADR-0029），采集途中的批次不过门——「原始采到数」与「最终结果数」在有过滤条件时天然不等。
  6. **计数可按 host 归集且零新消息**：`scan-progress` 的权威源是幂等表 `seen:{scanId}`（值是 `normalizeUrl` 后的 URL，host 保留），三站域名互斥，按 host 分组即得逐平台原始采到数。
  7. **web 组件无单测基建**（known gap，ADR-0057/0059/0060/0061/0068 同口径）：可判定逻辑抽 `web/src/lib/*.mjs` 纯函数 + `node --test`。

- **Scope:** web 层四处（`scan-progress` 路由、`explore-provider.tsx` 轮询循环、`discovering-state.tsx` 的 SourceChip、新纯模块 `browser-progress.mjs`）+ i18n 键若干。**不动**：扩展（background/content 的消息契约一字不改）、`browser-scan.ts` 兜底路径、ATS 模式的 chip 行为、采集门时机。

## Decision

1. **范围 = 仅扩展驱动主路径**。bsk CLI 兜底保持现状（平台整段完成才打勾）：给它做实时进度要改 `bsk-extract.mjs` 逐页输出，成本高且兜底路径本就少见。
2. **数据链路 = 扩展现有 2s 轮询，不新增通道**：`scan-progress` 响应在 `collected` 之外增加 `perSource: {zhipin, liepin, zhaopin}`（幂等表 `seen:` 命名空间按 URL host 归集，纯函数抽 `browser-progress.mjs::countByHost`）；active 平台继续取 `scan-status` 的 `active` 列表——浏览器模式下首次用它点亮 chip 的 active 态。
3. **分母 = 扫描发起时的快照**：前端在 `driveViaExtension` 里由 `targets × scanMax` 算出每平台上限合计，存入组件态；扫描途中改配置页不影响本次进度。猎聘拆词时显示**平台级聚合**（各词采到数之和 / 各词上限之和），不做逐词展开。
4. **计数语义 = 原始采到数**（幂等表口径），不过采集门。门是收尾统一跑的；途中过门要么前端每 2s 拉全量 scan-offers 本地过门（贵），要么在 SW/路由侧新做一套逐门计数（漂移风险），都不值。「采到 312、入库 40」是两条诚实的线，chip 说的是前者。
5. **chip 状态显示矩阵**（数字用 tabular-nums，与现有 3px bar 并存，bar 按 n/上限 爬）：
   | 状态 | 显示 |
   |---|---|
   | queued | 虚线 chip + `—/上限`（上限提前可见，配置生效一目了然） |
   | active | 橙点 + `n/上限` |
   | swept | `✓ n`，bar 满格转绿——采完未采满也转 ✓ 停比上限（上限不是目标，bar 不永远差一截） |
   | noisy | 保留 `~n skipped`，数字定格在失败时刻已采到的条数，不转 ✓ |
6. **全局 status 行保留**「已采集 N 条」（N = 各平台之和，与 chip 数字自洽，复用 `explore.disc.collected`），chip 与全局行是明细与汇总关系，不冲突。
7. **ATS 模式不动**：ATS chip 的 `done/total` 是公司数语义（扫了 150 家公司），与「采到 n 条职位」不同轴，两套语义不混显。浏览器模式复用同一 `SourceState.done/total` 字段承载条数，形状不变、渲染分支按 `isBrowser` 走。
8. **文案极简**：chip 内纯数字（`312/1200`、`✓ 240`，不带「条」字），唯一新增 i18n 面是 `—` 占位与既有键；暗色模式、`prefers-reduced-motion` 遵守现有 STYLE 块的底线。

## Alternatives considered

- **两条驱动都做实时进度**：要改 `bsk-extract.mjs` 的分页循环向 stderr 吐进度行、`browser-scan.ts` 解析转发——为一条少见的兜底路径付两套改动，被否。
- **过门后计数**：数字更贴近最终结果，但要么轮询拉全量 offer（每 2s 几百条 JSON），要么把门挪到批次上报点（与 ADR-0029「两路 driver 同一组合」的收口纪律冲突）。
- **逐词展开（猎聘「词1 180/400 · 词2 132/400」）**：精确但 chip 空间放不下，且对用户而言「词」是实现概念，不是他要控制的东西。
- **进度环替换 bar**：视觉新鲜，但 bar 已存在且 ATS 共用 chip 骨架，换环等于重画布局；窄屏 chip 密排时环比数字更挤。
- **永远显示 n/上限（收尾不转 ✓）**：能区分「供给就这么多」和「被截断」，但 240/400 的残缺 bar 视觉上像没跑完；「采满=截断」的区分按 Q3 用户选择了「采满或采完都转 ✓N」的简洁口径。

## Consequences

- **`scan-progress` 响应形状加长**（`perSource`）：只有探索页轮询消费，加字段向后兼容；每轮多一次 Set 遍历分组，幂等表单 scanId 至多几千键，成本可忽略。
- **浏览器模式 chip 首次有真状态机**：queued/active/swept 由轮询驱动而非只在收尾一次性置 swept——顺带修复「扫描全程所有平台都灰着像卡死」的既有观感缺陷。
- **「采到数」与「结果数」会出现不一致窗口**：有薪资/城市/关键词过滤时，chip 说 312、结果区可能只有 40。这是明说的取舍（决议 4），将来若用户投诉需新 ADR 统一口径。
- **`browser-progress.mjs` 成为第三处「host→平台」判定**（已有 `inbox-salary.mjs::salarySite`）：两处域名清单应保持一致，单测对映射上锁；新增平台时要同改。

## References

- ADR-0007（扩展驱动探索采集，E5 轮询上报 / E9 收尾 / E14 进度信号修正）——本 ADR 的宿主链路。
- ADR-0029（浏览器采集三道门 + 两路 driver 同组合）——「门在收尾跑、计数在原始层」的口径来源。
- ADR-0021（scan 只落 seen 幂等表）——`perSource` 归集的数据契约。
- `web/src/lib/scan-max.mjs` / `web/src/lib/inbox-salary.mjs`——上限配置与 host 判定的既有纯模块先例。

## 落地（2026-09-30）

- 实现：`web/src/lib/browser-progress.mjs`（新增）、`scan-progress` 路由、`explore-provider.tsx` 轮询接线、`discovering-state.tsx` chip 渲染（swept 转绿经 `data-engine="browser"` 收口，ATS 视觉不变）。
- 测试：`browser-progress.test.mjs`（8 用例）+ `bsk-progress-wiring.test.mjs`（源码守卫 4 用例）；web 全量 1227 pass，typecheck 绿。
- 验收截图：`.scratch/adr-0069/out/chips-light.png` / `chips-dark.png`（静态 harness 四态 + ATS 对照，harness 在 `.scratch/adr-0069/chips-harness.html`，不入产品代码）。
- 工单：`.scratch/bsk-platform-progress/issues/01、02`（均已 done）。
