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
4. 看板首页 `TodayDashboard` 新增「明日投递计划」卡片，复用 `Application.planned`，按文件行序展示。

## 范围（不动）

- **不动 SQLite 索引 schema**：`plan` 命令读 md 而非 `applications.db`，避免为新列迁库；
  `query` 等既有命令行为不变。
- **不动写门** `set-status.mjs`：`Planned` 是计划字段，不由状态迁移写入；手填或后续脚本设置。
- **不引入顺序列**：同日多岗顺序按 tracker 文件行序（用户拍板）。

## 后果

- 加列对正在运行的看板零影响（解析按列名，加列不会把 Score/Status 挤错位）。
- `tracker.mjs sync --check` 在 732 行上无漂移。
- 投完后把对应行 `Status` 改为 `Applied`（并写 `status-log.tsv`），其 `Planned` 值自然从 `plan` 列表消失。
