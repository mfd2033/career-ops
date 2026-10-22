# ADR-0088: tracker 增加 `Planned` 列（明日投递计划）

- 状态：采纳（2026-10-21）
- 决策人：用户（job-hunting 主线）

## 背景

求职主线的"明日投递清单"此前以仓库外本地 markdown（`job-hunting/明日投递清单-*.md`）
维护，与 career-ops 单轨真源约定冲突。该清单本质 = `Evaluated` 候选 + 一个计划投递日 +
顺序，正好是 tracker 现有数据加一个字段即可表达，无需另起文档。

## 决策

1. `data/applications.md` 表头在 `Status` 之后新增 **`Planned`** 列（计划投递日，ISO `YYYY-MM-DD`，
   空 = 未计划）。
2. 别名表 `tracker-aliases.json` 注册 `planned` / `计划投递` / `计划投递日` → canonical `planned`，
   Node（`tracker-parse.mjs`）与 web（`tracker-table.mjs`，共用同一别名表）按列名解析，**不破坏既有列对齐**。
3. 新增 CLI `node tracker.mjs plan [--date YYYY-MM-DD]`：直接读 md，列出 `Status=Evaluated`
   且 `Planned ≤ 目标日`（默认本地时区明天）的待投，替代本地 md。
4. 看板首页 `TodayDashboard` 新增「投递计划」卡片，复用 `Application.planned`；按本地**今/明/未来**
   三组动态展示（今日待投 / 明日待投 / 未来待投），遵循规则：今日有则显示今日、明日有则显示明日、
   都有都显示、都没有则卡片仅留标题且内容显示「无」。列表项在有评估报告时附「报告 ↗」入口
   （跳 `/report/{n}`，经 `app.report` 链接列判断存在性，`Report=—` 或空则不显示），与「职位 ↗」并列。

## 范围（不动）

- **不动 SQLite 索引 schema**：`plan` 命令读 md 而非 `applications.db`，避免为新列迁库；
  `query` 等既有命令行为不变。
- **不动写门** `set-status.mjs`：`Planned` 是计划字段，不由状态迁移写入；手填或后续脚本设置。
- **不引入顺序列**：同日多岗顺序按 tracker 文件行序（用户拍板）。

## 后果

- 加列对正在运行的看板零影响（解析按列名，加列不会把 Score/Status 挤错位）。
- `tracker.mjs sync --check` 在 732 行上无漂移。
- 投完后把对应行 `Status` 改为 `Applied`（并写 `status-log.tsv`），其 `Planned` 值自然从 `plan` 列表消失。

## 修订（2026-10-22）

- 卡片由「明日投递计划」（仅按文件行序列全部 `Evaluated`+`Planned`）改为「投递计划」按日期分组
  （今日待投 / 明日待投 / 未来待投），遵循用户规则：今明都有都显示、都没有显示「无」。
- 动因：用户期望首页能显示「今日待办」而不只是计划日清单；原卡片在当天岗投完变 `Applied` 后即整体
  消失，造成"待办清单不见了"的观感。按日期分组后，`Evaluated`+`Planned` 的岗稳定出现在对应日期组，
  且今日维度可独立呈现。
- 本地日期口径：前端 `new Date()` 本地时区（`getFullYear/Month/Date`），与 `Planned` 手填值、
  `status-log` 的 `localToday` 同源（career-ops server 与浏览器同机同区）。
