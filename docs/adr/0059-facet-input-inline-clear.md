# ADR-0059: 筛选输入框内嵌一键清空（收件箱 + Explore）

- **Status:** Accepted (2026-09-24)
- **Context:** 收件箱（`/pipeline` INBOX tab）的 `FacetChips` 有三个自由输入筛选框——公司/职位关键词（`kw`，宽幅）、地点（`locQ`，w-28 胶囊）、薪资下限（`salaryMin`，数字框）——输入错了只能手动全选删除。chip 行末尾虽有全局「清空」（仅 `anyActive` 时出现），但它会复位**全部** facet 含未评分/薪资排序两开关回默认（ADR-0024 决定 5）——用户只想清掉一个关键词时动作过重。Explore 页是同设计语言的镜像实现（`FilterBuilder` browser 模式的 `zhQuery`/`zhSalaryMin`、结果列表过滤框 `q`），同样没有内嵌清空，且连全局清空都没有。

## Decision

1. **内嵌 × 按钮，非空才显示，清空后焦点必落在输入框**。× 绝对定位在输入框内右侧，`value` 为空时不渲染；点击清空受控 state 后显式 focus 同容器的 input。仅靠 `onMouseDown` preventDefault 只能「不抢」焦点——冷点击（此前焦点在 body）时焦点不会落到输入框，冒烟实测暴露该缺口，故加显式 refocus 兜底，保证「清掉重搜」总是同一个连续手势。
   - 理由：行业标准搜索框模式，最简洁不占位；焦点保留是「清掉重搜」这一主路径的关键细节。
   - 代价：无。

2. **覆盖六处同语义自由输入框**：收件箱 `kw`/`locQ`/`salaryMin` 三框 + Explore `zhQuery`/`zhSalaryMin`/结果列表 `q` 三处。
   - 理由：两页是同一套筛选设计语言（FacetChips 自述 "Mirrors the Explore chip language"），只做一侧会造成体验分裂。
   - 代价：改动面从 1 个组件扩到 3 个组件 + 1 个新共享组件。

3. **不在范围内**：`zhCity`（下拉选择非自由输入，复位走 select 自身交互）；scan 模式 6 个 `KeywordField` 的「整字段清空」（每枚 chip 已自带删除 ×，整字段清空语义是删数据而非清文本，记为后续候选）；Esc 快捷键（后续增强候选）。

4. **抽共享微组件 `InputClearButton`**（约 10 行，仅 × 按钮本体），两页各自包裹自己的 input。
   - 理由：× 本体在 6 处重复，显隐规则、焦点保留、aria-label 模式一处维护；完整 `ClearableInput` 抽象因两页 DOM 形态差异大（小圆胶囊 vs 表单域）收益低，弃。
   - 代价：新增一个共享文件。

5. **与收件箱全局「清空」共存，全局清空行为不变**：× 只管单个输入框文本；全局清空继续重置全部 facet（含两开关回默认，ADR-0024 决定 5 不动摇）。Explore 页维持无全局清空现状。
   - 理由：职责分层——「单框清除」与「整套筛选复位」是两个不同频度的动作。

6. **清空语义 = 清输入文本，零破坏性**：只动受控 state，结果列表即时恢复；`salaryMin` 清空 → `null` → localStorage（`SALARY_FLOOR_KEY`）照常持久化为空。不触碰任何 chip/开关 facet。
   - 理由：纯前端视图层操作，无数据层、无网络请求。

7. **i18n：新增 5 个 aria-label 键（en/zh 对称）**：`inbox.clearKeyword`、`inbox.clearLocation`、`explore.filter.clearQuery`、`explore.filter.clearSalaryMin`、`explore.results.clearFilter`。薪资 × 键定义于 explore cluster、收件箱复用（沿用薪资下限键已有的跨集群复用先例）。

8. **布局细节**：可显示 × 的输入框常驻右侧留白（`pr` 加大），避免文字滚动到 × 下方；`locQ` `w-28` → `w-32` 容纳 ×；`salaryMin` 的 × 通过 className 定位点放在原生 number spinner 左侧，不隐藏 spinner（不改既有外观）。

## Alternatives considered

- **只做收件箱 kw 框**（最初推荐）：用户扩为收件箱三框 + Explore 三处，理由是两页同语言、分裂体验更差。采纳用户方案。
- **各处内联 × 按钮不抽组件**：不新建文件，但 6 处重复同一显隐/焦点/a11y 逻辑，后续调整需同步 6 处。弃用。
- **完整 `ClearableInput` 组件**：两页 DOM 形态差异大，强行统一会破坏各自布局。弃用，仅抽按钮本体。
- **全局清空改为只管 chips/开关、文本全交 ×**：更「一致」但改变既有行为（ADR-0024 决定 5），收益不抵迁移成本。弃用。
- **移除全局清空**：来源/年资/开关等 chip 将无处一键重置。弃用。

## Consequences

- 六处筛选输入框获得一致的一键清空；交互规则（非空显隐、焦点保留、aria-label）在 `InputClearButton` 一处维护。
- 新文件 `web/src/components/input-clear-button.tsx`；改动 `facet-chips.tsx`、`filter-builder.tsx`、`results-list.tsx`、i18n `clusters/inbox.ts` + `clusters/explore.ts`。
- 收件箱全局清空、Explore 无全局清空、scan 模式 chip 字段、`zhCity` 下拉：全部维持现状。
- **已知残差**（同 ADR-0057 做法）：web 组件无单测基建，验收靠手动冒烟；Explore 结果过滤框 `q` 因无结果数据未渲染，未冒烟（与其余 5 处共用同一微组件，类型检查通过）。后续候选：scan 模式 KeywordField 整字段清空、Esc 快捷键、zhCity 下拉复位按钮。

## 实现拆分（供 to-tickets 参考）

1. 共享微组件：`web/src/components/input-clear-button.tsx` — props: `show`/`onClear`/`label`/`className`；onMouseDown preventDefault + onClick 清空后显式 focus 同容器 input
2. 收件箱：`facet-chips.tsx` 三处接入 + `pr` 留白 + `locQ` 加宽 + salaryMin × 定位
3. Explore：`filter-builder.tsx` browser 模式两处接入；`results-list.tsx` q 接入
4. i18n：`clusters/inbox.ts` +2 键、`clusters/explore.ts` +3 键（en/zh 对称）
5. 验收：手动冒烟——六处 × 非空才显示、点击清空且焦点保留、列表即时恢复、收件箱全局清空行为不变
