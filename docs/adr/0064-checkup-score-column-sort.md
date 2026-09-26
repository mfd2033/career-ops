# ADR-0064: 管道表体检列与体检分数排序

- **Status:** Accepted (2026-09-26)
- **Context:** 需求（2026-09-26 grill 会话）：「web 端，已评估页面可以按体检分数排序，和分数、日期等列一样」。现状与约束：

  1. **体检★目前只是角标。** `data/company-checkups.tsv` 台账经 `checkupIndex` 聚合成 `tracker# → CheckupEntry`（`star` 最近一次、`minStar` 历史最低、`date`、`risks`、`count`），在表格里只以公司单元格内的着色角标 + 悬停提示出现，没有独立列、没有排序键。
  2. **既有契约明文禁止体检参与排序。** `pipeline-view.tsx` 与 `career-ops.ts` 的注释（ADR-0025 遗产）写着「Pure display — never feeds sort/filter/score」。本 ADR 有意识地放开其中 **sort** 这半句；filter / score / 任何门禁仍然禁止——体检分绝不改变匹配分或行去留。
  3. **排序比较器是双侧共享的。** `pipeline-order.mjs` 里那一个 `compareByKey` 同时喂列表页 `orderApplications` 与详情页 `navNeighbors`（ADR-0036）；薪资列（ADR-0037 决议 6/9）已确立两个先例直接被本列继承：未知值**恒沉底**（不乘 dir）的口径，以及详情页仅在需要该排序键的全量 join 时付费读盘（`ctx.sortKey === "salary" ? withReportSalaries(...) : ...`）。
  4. **`SORT_KEYS` 有两份镜像**（`pipeline-order.mjs` 与 `pipeline-view.tsx`），加键须两处同改——ADR-0037 已知的脆弱点，本 ADR 依旧不新增收敛机制。
  5. **不挂 tracker# 的体检行天然不参与。** 台账里公司级体检（tracker# 为 `?`）不进 `checkupIndex` 的 tracker 键空间，列与排序都只认按行 join 到的记录。

- **Scope:** web 层四处——`pipeline-order.mjs` 的 checkup 排序分支、`pipeline-view.tsx` 的新列（表头 + 单元格）、服务端把 star join 到行上的辅助函数（列表页与详情页两个落点）、i18n 新键。**不动**：`data/company-checkups.tsv` 的 schema 与写入路径、`checkupIndex` 聚合逻辑、公司格内现有角标、「建议体检」懒加载链路、min 过滤（仍是匹配分下限）、默认排序（仍是 score 降序）。

## Decision

1. **新增独立可排序「体检」列**，排序键 `checkup`；公司格内现有 ★ 角标**保留不动**，两处消费同一份 `checkups` 数据，不产生第二事实源。
2. **排序值 = 最近一次体检 `star`**（与角标/悬停口径一致），不用 `minStar`——「这家公司现在怎么样」回答的是最新证据，历史最低只存在于悬停提示里。
3. **列出现在全部含 tracker 行的 tab**（含 EVALUATED），不做按 tab 显隐——与薪资/时长列同构，切 tab 不跳变；INBOX 是 triage 队列不是 tracker 表，本就不经此路径。
4. **列位置紧跟薪资列后**：…分数 → 薪资 → 体检 → 时长 → 状态 → 日期 → 来源。`SORT_KEYS` 数组顺序即列序，两个镜像同步插入。
5. **单元格 = `★4.0` 一枚着色星标**（沿用 `checkupTone` 配色阈值），悬停复用现成 `checkupTitle`（日期/风险/历史次数）；未体检格留空，与薪资列「—」的诚实空值同一精神。
6. **未体检行恒沉底**：不论升降序都在最后，实现为 `compareCheckup` 不乘 dir（ADR-0037 决议 6 的口径原样继承，一个「未知不是极小值」的概念只定义一次的取向）。star 平手 → score 降序 → 报告号降序，完全确定，不依赖 `Array.sort` 稳定性。
7. **台账缺失/整列无值时排序仍确定**：全部行都是未知 → 平手回退链把顺序收敛为 score 降序 → 号降序，优雅退化而非乱序。
8. **排序键进共享模块与 URL 上下文**（`?sort=checkup`），经 `buildContextQuery` 序列化进行链接；详情页 prev/next 一起支持——`ctx.sortKey === "checkup"` 时对 `readApplications()` 做 star join 再喂 `navNeighbors`（ADR-0037 决议 9 的按排序键付费模式），其余排序键不付这次读盘成本。列表所见顺序与「下一个」所走顺序永不漂。
9. **点列头默认降序（高星在前）**，再点切换，与现有数值列一致；默认视图不变。
10. **契约文案同步修正**：「never feeds sort/filter/score」改为「参与排序；仍不参与 filter/score/任何门禁」。i18n 新键 `pipeline.col.checkup`（en `checkup` / zh `体检`，与兄弟列标签的小写惯例一致，表头 CSS 自带 uppercase）。

## Alternatives considered

- **只让现有角标可点击排序（不加列）**：表头少一列，但违背「和分数、日期等列一样」的直觉，可发现性差。
- **新列并移除公司格角标**：表更干净，但改动面扩大到角标的既有测试断言（ADR-0062 锁定了角标在 `</Link>` 之后的结构），且「建议体检」提示仍要在公司格渲染，删★留提示反而分裂两种视觉语言。
- **仅 EVALUATED tab 显示**：贴合需求字面，但需要额外的按 tab 显隐逻辑；数据按 tracker# 索引在任何 tab 都能 join，特判是白付的复杂度。
- **`-Infinity` 惯例（升序时未体检浮顶）**：与其它数值列实现统一，但「按体检从低到高」时最顶上一片是没体检过的行——正是要避免的误读（未检 ≠ 最差）。
- **按 minStar（历史最低）排序**：更保守，但角标显示的是最近一次，排序列与角标口径分裂。
- **详情页导航不跟（仅列表排序）**：实现最小，但直接违背 ADR-0036 立下的「列表与导航同一比较器同一行数据」契约，正是既有测试专门防过的漂移。

## Consequences

- **覆盖率是明说的代价**：只有体检过的行有值，未体检行整列空且恒沉底；列不是「每行都有值」的承诺（与薪资列同一处境）。
- **体检分获得了一次「可被看见」的通道，但没有获得任何决策权**：它不影响 min 过滤、匹配分、状态、批量动作资格；放开 sort 不破 filter/score 的口子需要靠测试与注释守住。
- **每次 ★ 角标的悬停口径改动会同时影响列悬停**（共用 `checkupTitle`），这是单一事实源的红利而非缺陷。
- **详情页多一种「按排序键 join」分支**：`salary` 与 `checkup` 各一次全量读，其余排序键零额外成本；两个 join 函数形状相同（把派生值挂到行上），暂无合并必要。
- **已知脆弱点（继承）**：`SORT_KEYS` 双镜像须两处同改，漏一侧表现为表头与排序行为脱节，靠 `pipeline-order.test.mjs` 的 checkup 用例兜底。

## References

- ADR-0025（公司体检台账集成）——其「纯展示」契约被本文决议 10 局部放开，filter/score 部分继续有效。
- ADR-0036（报告详情页导航上下文）——比较器双侧共享、导航不得漂移的约束来源。
- ADR-0037（薪资列）——恒沉底、平手回退链、按排序键付费 join 三个口径的出处。
- ADR-0041（已评估页批量体检）——「建议体检」懒加载链路，本列不依赖它。
