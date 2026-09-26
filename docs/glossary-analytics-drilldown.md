# Glossary — 分析页下钻跳转

协同阅读：`docs/adr/0067-analytics-drilldown-links.md`

## 跳转与口径

- **下钻跳转（drilldown link）**：分析页条形行整行成为链接，点击落到求职管道页并展示与该条形**同一口径**的行列表。判据只有一个：落地列表行数 == 条形上的数字。
  _Avoid_: 筛选跳转（不区分口径的泛称）、深链（deep link 更宽，含首页统计卡等非计数入口）
- **严格计数一致（exact count parity）**：ADR-0067 的核心约束——分析页怎么数，管道就怎么滤；两者共用 `pipeline-order.mjs` 的过滤式与 `buildContextQuery` 的序列化，任何一侧改口径必须同步另一侧。
  _Avoid_: 近似匹配（被明确否决的替代方案）
- **半开区间（half-open bucket）**：分数桶 `[min, max)`——含下限、不含上限（4.0–4.4 桶 = `min=4&max=4.5`）。与分析页 `>= && <` 的桶定义同构；无效分数行被排除，同"只数有效分数"口径。
- **公司精确匹配（exact company match）**：`company=` 参数与 `a.company` 原始字符串全等（区分大小写），与分析页 Map 分组同一口径。匿名雇主 `?` 按字面匹配。
  _Avoid_: 公司搜索（`q` 是模糊子串，命中职位名，两码事）
- **ever 累计（cumulative tile）**：头条面试/offer 统计的"曾经到达过"语义（`cumulativeTiles`），管道 tab 只表达当前状态，无法精确承载——故四枚统计卡不做下钻。
  _Avoid_: 当前状态（tab 的语义，与 ever 相对）

## URL 上下文

- **落地上下文（landing context）**：跳转链接自带完整 URL 参数（分数/公司跳转固定 `tab=ALL`，否则落 INBOX 空列表），不做跨页记忆。
- **上下文透传链（context carry）**：`normalizeContext` → `orderApplications` → `buildContextQuery` → 详情页 `parseContext`/`navNeighbors`——列表行链接、prev/next、返回链接 reproduce 同一视图（ADR-0036 契约），新参数必须整条链路一起生效。
- **非法值降级（silent fallback）**：`max=abc`、空 `company=` 一律按"无该筛选"处理而非报错，与 `min` 既有姿态一致。

## 管道页呈现

- **分数区间 chip（range chip）**：分数是一个维度、一枚 chip——无 `max` 时维持「分数 ≥ x ✕」现状；有 `max` 时单枚显示完整区间（「分数 4.0–4.5」/「分数 < 3.0」），清除时 min 与 max 一起清。
- **公司 chip（company chip）**：「公司: xxx ✕」独立一枚，与分数 chip、搜索框 `q` 全部 AND 叠加。
  _Avoid_: 塞进搜索框（被否决——污染用户搜索词且破坏严格一致）
- **死交互行（dead row）**：计数为 0 的条形行——无链接、无 hover，点了只会得到空列表的行不为可点付出代价。
- **tabs 行 chip 纪律**：所有筛选 chip 住 tabs 行（ADR-0039 决议 5 继承）——chip 挂载/卸载不得改变列表高度、不得引起跳位。
