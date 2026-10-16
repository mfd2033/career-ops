# ADR-0079: 跟进卡片「建议冻结」——沉默判定、冰蓝语义色与 Discarded 写路径（career-ops-49）

## 状态

Accepted (2026-10-16)

## 背景

需求（Kaneo 任务 career-ops-49）：跟进追踪器 `/followups` 对「已读不回」的行给出**建议冻结**信号——跟进过 N 天、对方已读无回复，继续挂着只是心理负担；一键把行转为 Discarded（附原因），让用户体面收尾。交互原型已经用户逐项确认并定稿（`.scratch/freeze-ui-proto.html` → 嵌入真实页面 `?freezeProto=1` 验证通过，Playwright 冻结→撤销流程 PASS）。

既有事实与约束：

1. **写门唯一且已完备**：`POST /api/status`（`{n, status, note?}`）委托 `set-status.mjs --row --source web`——共享 tracker 锁、`templates/states.yml` 校验、`data/status-log.tsv` 账本、exit code → HTTP 映射。冻结 = 写 `Discarded`，**不新增任何写面**；撤销 = 反向写回原状态，status-log 如实记两腿（与 ADR-0077 撤销同构）。
2. **引擎已有静默天数的数据底座**：`followup-cadence.mjs` 从 `applications.md` + `follow-ups.md` 算出 `daysSinceLastFollowup` / `daysUntilNext` / `urgency`。本需求的 `silenceDays` 就是「距上次跟进（无记录则距申请日）的天数」，同一数据源，引擎侧只是多输出一个字段。
3. **已读/未读没有自动信号**：邮件回执、LinkedIn 已读回执在本仓库均不可得。「已读不回 vs 未读」唯一可靠来源是**用户人工标注**（如 LinkedIn 显示未读）。因此 v1：`data/follow-ups.md` 的 log 行支持可选 `[unread]` 标记（`log` 模式 / web LogDialog 的渠道区旁一个 checkbox 或手打标记均可，取最简实现），未标注默认 `read`。
4. **responded 不参与冻结**：`responded` = 对方已回应，是双向互动；冻结语义只适用于 `applied` / `interview`（引擎 `ACTIONABLE_STATUSES` 口径，ADR-0075/0077 同源）。
5. **视觉语言已在原型定稿**（多轮用户迭代收敛）：
   - **冰蓝为冻结专属语义色**（`hsl(203 52% 68%)` 系），与红（overdue）/琥珀（urgent）/橙（brand）互斥编码；
   - 沉默列单行「图标 + 数字」：`❄ 4`（冰蓝，已读不回达阈值，悬停「建议冻结」）、`✉ 5`（弱灰，未读，悬停「未读 · 再看一眼」）、纯数字（默认）；
   - 操作列 ❄ 图标按钮（与 📅 钉日期、📓 记录同规格，title/aria 保留全称）；
   - 「建议冻结」tab 常驻 + 计数；
   - 列头极简（申请/下次/次数/距今，完整语义在悬停 `colHint`）；紧急度 badge 走 i18n。
6. **i18n 键已随原型落位**（`web/src/lib/i18n/clusters/followups.ts`，en+zh，`followups.freeze*` / `col.silence` / `urgency.*` 等），实现时直接消费，不再新增第二份文案。
7. **组件无测试面**（ADR-0077 同款约束）：可测逻辑（冻结判定、`[unread]` 解析）抽在引擎/纯 .mjs 层用 node --test 门；UI 靠 build + 手测。

## 决策

1. **冻结判定 = 引擎输出，不进前端**：`followup-cadence.mjs` 每行新增输出 `silenceDays`（null = 无跟进记录且申请未达阈值口径的兜底）、`readState`（`"read" | "unread" | null`，来自 follow-ups.md 的 `[unread]` 标记）、`freezeSuggested`（布尔）。规则：`status ∈ {applied, interview}` 且 `readState === "read"`（默认）且 `silenceDays ≥ freeze_threshold_days` → `freezeSuggested: true`；`unread` 永不为 true（未读只是「再看一眼」，不是「放弃」）。阈值默认 **14 天**，进 `DEFAULT_CADENCE.freeze_threshold_days`，profile.yml cadence 键 `freeze_threshold_days` 可覆盖（ADR-0073 引擎配置写边界同源）。
2. **入口 = 沉默列 + 操作列 ❄ 按钮**：沉默列呈现判定信号（决策见背景 5），操作列 ❄ 图标按钮打开 FreezeDialog。FREEZE tab 过滤 `freezeSuggested` 行，计数随数据走。
3. **FreezeDialog = 证据 + 原因预填 + 后果声明**：冰蓝顶边；证据三行（沉默天数 / 最后跟进日期与次数 / 状态与申请天数）；原因输入框**预填**「跟进 {N} 天无回复」可编辑——预填文本只进确认请求，不落任何文件；底部声明「确认后状态写入 Discarded，10 秒内可撤销」。确认 → `POST /api/status` `{n, status: "Discarded", note: reason}`。
4. **成功 toast 带「撤销」（10 秒窗口）**：冻结是比改状态更重的决策，撤销窗口取 10s（ADR-0077 改状态 5s 的加重版）。撤销 = 再发一次 `POST /api/status` 回原状态（原状态从 toast 闭包携带），status-log 如实记两腿；撤销失败落 `actionError`。窗口过后行已离开列表，从报告页改回（低频 + 兜底，同 ADR-0077 边界）。
5. **`[unread]` 标记解析在引擎侧**：`followup-cadence.mjs` 解析 follow-ups.md log 行尾的可选 `[unread]` token → `readState: "unread"`（该申请最近一次跟进带标记即 unread）；`log` 模式（`log-followup.mjs` 系）与 web LogDialog 提供标注入口，实现取最简（checkbox → 行尾 token）。无任何标记 = `read`，口径默认「已发出即视为对方可读」。
6. **删除 `?freezeProto=1` mock 分支**：`web/src/lib/followups.ts` 的预览字段注释改为正式字段、`followups-view.tsx` 删除 mock 注入与 flag 门控，UI 代码（沉默列/❄ 按钮/tab/FreezeDialog/toast）按原型定稿保留。

## 被拒方案

- **自动判定已读/未读**（否决）：无可靠信号源，猜测比缺失更糟；人工 `[unread]` 标记是唯一诚实来源。
- **responded 也参与冻结**（否决）：对方回应过仍不回，应由 responded cadence 的紧迫度表达，不是「冻结」语义。
- **冻结 = 删除行 / 移出 tracker**（否决）：Discarded 是 canonical 状态、status-log 全程记账，删行破坏账本完整性。
- **撤销只回退前端内存**（否决）：同 ADR-0077 拒过的形状——必须真实写回。
- **预填原因直接落 notes 不经用户**（否决）：原因可编辑是确认对话的一部分；静默写入是替用户做陈述。
- **web 侧复算 freezeSuggested**（否决）：第二份判定逻辑漂移缺陷类；引擎单点输出，前端只消费。

## 后果

- 正面：「已读不回」从心理负担变成一键收尾；判定、写路径、错误语义零新增维护面；冰蓝语义色为后续「冻结/归档」类交互建立编码先例。
- 代价一：follow-ups.md log 行新增可选 token，旧记录无标记默认 read——语义上正确（默认口径），无需迁移。
- 代价二：status-log 出现「Discarded + 撤销」成对记录——账本如实，不做合并（同 ADR-0077 代价二）。
- 已知边界：未读标注是人工动作，忘标注的「实际未读」行会在 14 天后被建议冻结——❄ 只是建议，确认对话里用户可自行察觉；撤销窗口 10s 后只能从报告页找回。
- 回滚：引擎新增输出字段为纯增量；web 视图层增量（组件 + i18n + flag mock 删除），可独立退回；无数据迁移。

## References

- 写门与锁语义：`web/src/app/api/status/route.ts`（委托 `set-status.mjs`，ADR-0077 决策 4）
- 引擎配置写边界：ADR-0073；可跟进口径：`followup-cadence.mjs` `ACTIONABLE_STATUSES`、ADR-0075
- toast/撤销惯例：ADR-0077（5s）、收件箱删除 toast（5s）；本 ADR 加重为 10s
- 视觉令牌：`web/src/app/globals.css`（`--ice` 系新增）；lucide `Snowflake`/`Mail`/`NotebookPen`/`ArrowLeft`
- 用户定稿原型：`.scratch/freeze-ui-proto.html`；真实页面验证：`/followups?freezeProto=1` + `.scratch/verify-freeze.mjs`
- i18n 键（已落位）：`web/src/lib/i18n/clusters/followups.ts`
