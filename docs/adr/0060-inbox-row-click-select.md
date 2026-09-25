# ADR-0060: 收件箱行点击选中（延伸 ADR-0038，新增拖拽/选区守卫）

- **Status:** Accepted (2026-09-25)
- **Context:** 需求（2026-09-25，四轮 grilling 敲定）：web 端管道页收件箱（INBOX tab）中，点击复选框以外的行区域也能选中该行。现状与约束：

  1. **tracker 表已有行点击选中先例**（ADR-0038：`pipeline-view.tsx` 的 `<tr>` `onClick` + 复选框格与三个 Link 单元格 `stopPropagation` + `cursor-pointer`）。收件箱 `TriageRow`（`inbox/triage-row.tsx` 的 `<li>`）未接入，选中仍只能通过行首小 checkbox（触控目标已放大到 44px，但热区仍小）。
  2. **收件箱行的热区结构与 tracker 表不同**：标题「公司 · 职位」整体被一个 `<a target="_blank">` 包裹（打开原始职位帖，是全行最大可点面积，`openableUrl` 不可开时降级为纯文本），右侧还有评分徽章 `<Link>`（跳 `/jobs/{id}`）、Save / Skip 两个按钮。逐个控件挂 `stopPropagation` 会散落多处、日后加控件必漏——集中判定才是对的形状。
  3. **标题文字是复制对象**：用户会拖选「公司 · 职位」去搜索/粘贴，拖拽松手会触发一次 click；tracker 表格子短文本无此问题，所以 ADR-0038 没做守卫，收件箱必须做。
  4. **web 组件无单测基建**（ADR-0057/0059 已登记的 known gap）：本仓库口径是把可判定逻辑抽成 `web/src/lib/*.mjs` 纯函数、用 `node --test` 锁行为（ADR-0055 同法）。

- **Scope:** web 层收件箱——`triage-row.tsx` 行事件接线 + 新纯函数 `row-click.mjs` + 其单测。**不动**：tracker 表的既有行点击（ADR-0038 原样）、`inbox-triage.tsx` 的选中集状态管理（`Set<urlKey>` toggle）、批量栏、评分/筛选逻辑、移动端布局。

## Decision

1. **整行可点，扣除所有交互控件**：`<li>` 加 `onClick`，命中判定用集中式 `closest('a,button,input')` 排除——checkbox、标题链接、徽章链接、Save/Skip 一律不劫持，各自维持原行为。不采用 ADR-0038 的逐控件 `stopPropagation`（约束 2：结构不同，集中判定抗漏）。
2. **标题链接保持「打开原帖」，不参与选中**：「先看 JD 再决定选不选」是收件箱主流工作流，标题点击改选中的肌肉记忆破坏不划算；修饰键区分（Alt+点击打开）可发现性太差，否决。
3. **拖拽 / 文本选区守卫**：行点击处理前两道闸——① pointerdown→click 的指针位移超阈值（5px）视为拖拽，不切换；② 释放时页面存在非折叠文本选区（用户刚拖选出文字），不切换。复制文字不得意外选中行。
4. **选择语义不变**：click 与 checkbox 都只做 toggle 多选；不引入 Shift 范围选择（独立功能，不混入本次热区扩大）。
5. **桌面 + 移动一致启用**：不加设备分支；行点击反而比小 checkbox 更好点，误触由 toggle 可逆性与既有 Undo toast 兜底。
6. **affordance 与无障碍**：`<li>` 加 `cursor-pointer`；hover 高亮与选中底色沿用现状；不加 tooltip、无新增 i18n 文案；键盘路径保持 checkbox 唯一（`li` 不新增 role/tabindex，checkbox 已带 aria-label）。
7. **纯函数 + lib 单测（TDD）**：排除判定、位移阈值、选区闸抽成 `web/src/lib/row-click.mjs`（零 DOM 依赖，入参用结构化最小对象以可单测），单测落 `web/tests/lib/row-click.test.mjs`；`triage-row.tsx` 内只剩事件接线。

## Alternatives considered

- **逐控件 `stopPropagation`（照抄 ADR-0038）**：收件箱行内链接是包裹整段标题文字的 `<a>`，逐格挂挡既啰嗦又抗不住后续加控件；被集中式 closest 判定替代。
- **标题点击=选中、打开降级到 hover 小图标**：选中效率最高，但破坏既有肌肉记忆、移动端无 hover；用户已选「标题保持打开」。
- **禁止行内文本选择（user-select:none）**：从源头消灭误触但牺牲复制便利，治标伤本。
- **不做拖拽守卫**：实现最简，但「复制完文字行莫名被选中」会被当 bug 回报回来。
- **Shift 范围选择一并做**：扩大 diff 与测试面，与热区扩大无依赖关系，留作独立候选。
- **li 级键盘可选（role/Enter）**：改动面大且与批量栏焦点管理叠加易出 bug；checkbox 已是可达键盘路径。

## Consequences

- 收件箱批量选中效率显著提升（整行热区 vs 16px checkbox）；tracker 表与收件箱两处行点击语义一致，但实现形状不同（closest 排除 vs stopPropagation），互读时以各自 ADR 为准。
- 拖拽守卫阈值 5px 是工程常数，锁在单测里；若日后接入指针事件之外的手势（如触摸板惯性点击）需复核。
- 行点击选中不改变选中集结构（仍 `urlKey` 键、跨筛选保留），ADR-0057 批量删除 / 批量跳过等消费方零改动。

## References

- ADR-0038（tracker 表行点击选中先例，本 ADR 的延伸对象与实现差异来源）。
- ADR-0057（收件箱批量操作，选中集消费方）。
- ADR-0055 / ADR-0059（web 组件无单测基建时「抽纯函数 + node 单测」的口径先例）。
- `web/src/components/inbox/triage-row.tsx`、`web/src/components/inbox/inbox-triage.tsx`。
