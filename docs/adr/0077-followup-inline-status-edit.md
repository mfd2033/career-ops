# ADR-0077: 跟进追踪器状态列内联改状态（点击胶囊弹 9 态选择；写路径与错误语义全复用既有唯一门）

## 状态

Accepted (2026-10-16)

## 背景

需求：在 `/followups` 跟进追踪器直接改某行的投递状态，不必跳到报告页（`/pipeline/{n}` / `/report/{n}`）再改。用户已确认交互原型（2026-10-16）：点击状态胶囊 → 原地弹出 9 态菜单 → 乐观更新 + 橙色闪烁 + toast（带撤销）→ 列表刷新。

既有事实与约束：

1. **写门唯一且已完备**：`POST /api/status`（`{n, status}`）委托 `set-status.mjs --row --source web`——共享 tracker 锁、`templates/states.yml` 校验、`data/status-log.tsv` 账本、exit code → HTTP 映射（#2900 的结论）。本次**不新增任何写面**。
2. **行号即真值键**：`CadenceEntry.num` 就是 tracker 行号（ADR-0075 判定同源），`n = e.num` 直接可用。
3. **字典与错误文案的真值都在别处**：`CANONICAL_STATES` 在 `@/lib/format`；写失败 → 文案映射在 `status-write-error.mjs`（ADR-0036，纯函数 + node --test 已门）。web 侧再复制任何一份都是 #2704/#2369 修过的「多份字典漂移」缺陷类。
4. **报告页控件形态不可平移**：`StatusSelect`（label + `<select>` + 错误行）宿主在报告页动作区，空间充裕；跟进页状态列是紧凑 Badge，列宽和行高容不下第二个控件形态。复用的是真值（字典 / 错误映射 / 端点），不是控件本体。
5. **改状态会改变行的「可跟进」资格**：core 的 `ACTIONABLE_STATUSES = applied/responded/interview`（ADR-0075）。把行改成其余 6 态之一（Offer/Hired/Rejected/Discarded/SKIP/Evaluated）后，该行**从跟进追踪器消失**——这是口径如实的呈现，不是缺陷。web 侧不复制这个集合做判断（防漂移），消失本身自解释。
6. **页内反馈惯例**：收件箱删除 toast（5s 自动消失 + 撤销）与 ADR-0075 报告页轻提示是既有模式；跟进页视图层已有 `actionError` 展示位。
7. **组件无测试面**：本仓库无 jsdom/React 测试设置（status-write-error.mjs 头注）；可测部分抽纯 .mjs，UI 组件靠 build + 手测。本次恰好**没有新增纯逻辑**——所有决策分支都在既有模块里。

## 决策

1. **入口宿主 = `/followups` 表格的状态列**：`Badge` 换为胶囊按钮（`StatusPill`，新组件归 `web/src/components/followups/` 一族），样式沿用 `followupStatusTone` 的 tone 语义，加下拉 chevron 与 hover 环。报告页 `StatusSelect` 不动。
2. **弹层 = listbox 形态**：9 个 `CANONICAL_STATES` + 未知状态兜底项（同 StatusSelect 的 known 分支）；当前项打勾；Enter/Space 开、↑↓ 移动、Enter 选、Esc 关、外点关；`role="listbox"` + `aria-expanded`/`aria-selected`。~~选项文案用 canonical 原形式~~ **（2026-10-16 用户修订：胶囊、选项与 toast 的新旧状态全部改走既有 `pipeline.status.*` 字典，与报告页 StatusSelect 同源——推导收敛在 `statusI18nKey()` 单点，canonical 原形式仅作未知状态兜底，仍不新增第二份翻译）**。
3. **弹层方向自适应**：按钮贴近视口底部时向上弹，否则向下弹——表格容器 `overflow-x-auto` 会裁剪越界弹层，最后一行向下弹必被裁。
4. **写路径 = 仅 `POST /api/status`**：乐观更新 → 成功 `onChanged` → 视图 `refetch()`（cadence 重算，与页面既有数据流一致）；失败回退 + `describeStatusWriteError` / `offlineStatusWriteError`（语义原样：失败从不静默，504 文案如实说「可能已生效」）。复用路由的锁等待/超时语义，零改动。
5. **成功 toast 带「撤销」（5s 自动消失，收件箱同款）**：文案「状态已更新：{company} {from} → {to}」。撤销 = 再发一次 `POST /api/status` 回旧值——status-log 如实记两次往返，不造假账；撤销失败落 `actionError`。撤销窗口关闭后行若已离开列表，就地无入口，从报告页改回（可接受：低频误操作 + 5s 窗口 + 报告页兜底）。
6. **不联动、不加第二个动作**：不改备注、不弹终态确认（撤销 toast 已覆盖误操作窗口，多一步确认是 ADR-0075 拒过的表达）；列表行不因此加任何其他按钮。

## 被拒方案

- **复用 `StatusSelect` 本体**（否决）：`<select>` 形态在紧凑表格里挤压行高、视觉突兀；双宿主共享的应是真值而非控件。
- **撤销只回退前端内存**（否决）：`refetch` 后立即与数据层矛盾——撤销必须真实写回。
- **改终态前弹确认**（否决）：多一步打断高频操作；5s 可撤销窗口 + status-log 全程记账已覆盖风险。
- **web 侧复制 `ACTIONABLE_STATUSES` 做消失前提示**（否决）：第二份集合漂移缺陷类；行消失 + 计数变化已足够自解释。
- **终态隐藏入口 / 禁用渲染**（否决）：与 StatusSelect 的 unknown-兜底惯例不一致；跟进页根本不会出现不可跟进行，兜底仅为防御旧数据。

## 后果

- 正面：跟进追踪器就地改状态，与记录跟进（ADR-0075）、固定下次日期同页闭环；写路径、错误语义、状态字典零新增维护面。
- 代价一：表格行内多一个弹层交互面，`overflow` 裁剪需方向自适应（决策 3），实现上多一处 DOM 位置判断。
- 代价二：status-log 会出现「改 + 撤销」的成对记录——账本如实，不做合并。
- 已知边界：撤销窗口（5s）过后改终态的行只能从报告页找回；弹层打开时若 refetch 使行消失，弹层随行卸载（可接受，低概率）。
- 回滚：视图层增量（组件 + i18n keys + 列替换），可独立退回；无数据迁移。

## References

- 写门与锁语义：`web/src/app/api/status/route.ts`（#2900 委托 set-status.mjs）
- 错误文案契约：`web/src/lib/status-write-error.mjs`（ADR-0036）
- 可跟进判定口径：`followup-cadence.mjs`（`ACTIONABLE_STATUSES`）、ADR-0075
- toast 惯例：`web/src/components/inbox/inbox-triage.tsx`（删除 + 撤销 5s）、`web/src/components/followups/log-followup-button.tsx`
- 用户确认的原型：`output/prototype-followup-inline-status.html`
- 工单：`.scratch/followup-inline-status/issues/01–03`
