# Glossary — 批量体检（已评估页）

协同阅读：`docs/adr/0041-batch-checkup-evaluated-page.md`

## 通路

- **批量体检（batch checkup）**：已评估 tab 勾选多家公司后一键触发的体检编排；每家公司一个独立无头 worker，产物走与单个体检完全相同的台账/HTML 通道。
- **单体检通路**：报告页「体检这家/复检」按钮 → `/api/checkup-request` 前置闸门 → `/api/run` 无头 worker → 产物门禁 → 台账落盘。批量体检复用其 worker prompt 与产物验收，不复用其 409 交互。
- **编排蓝本（batch-evaluate shape）**：批量评估验证过的批量形态——预留资源 → 有界 worker 池 → NDJSON 流式事件 → 诚实门禁汇总 → 收尾清理。批量体检镜像此形态，但不涉及报告号段预留与 tracker 合并（体检不写 tracker）。

## 勾选与提示

- **建议体检口径（ADR-0025 口径）**：score≥4.0 或 Block G ⚠ 的公司建议体检。批量体检中仅作为列表角标提示，不参与任何自动决策。
- **建议体检角标**：满足口径且台账中该 tracker# 无记录的已评估行上的轻量标记。只提示不强制。

## 冲突与复检

- **跳过在跑（skipped-running）**：批量启动时逐项查 `checkup-live.mjs`，已有在跑体检的公司跳过并在结果流标注。区别于单体检的 409 交互与 ADR-0033 replace——批量不做自动替换。
- **复检（re-checkup）**：对已有台账记录的公司再跑一次体检；台账 append-only 追加新行，星级徽章取最新行并显示复检次数。批量勾选中「勾选已有记录的公司」即复检。
- **tracker# 空键（`?`）**：invite-match 未命中时的哨兵键；台账允许 `?` 行（不算孤儿），但星级徽章不显示 `?` 行。

## 门禁

- **产物门禁（ADR-0030）**：体检成功的判据 = `data/company-checkups.tsv` 中该 tracker# 的台账行数增加 **且** 声明的 HTML 文件真实存在（`--html -` 未声明附件的行按 ADR-0030 决议 1 容忍计入）。门禁按 tracker# 过滤计数——批量里 N 个 worker 并发写同一台账，全局差值无法归属到具体某家。
- **诚实门禁（honest gate）**：批量汇总语义——`ok=0 && failed>0` 时发 `error` 而非 `done`，全失败不得伪装成功。源自批量评估的事故教训。
- **逐项 reason**：每个失败项在结果流/运行台账中携带失败原因（反爬、验证码、产物缺失等），弥补批量评估「全失败零原因」的观测性缺口。
- **不自动重试（no auto-retry）**：失败项只进清单，由用户稍后手动复跑；反爬类失败立即重试大概率仍失败。

## 运行时

- **worker 引擎跟随配置（cliId）**：批量体检与单体检、批量评估一致，引擎由配置页 `cliId` 决定（8 个 CLI）；claude 附加 `permissionFlags` 工具授权，其他引擎现状为无授权机制运行（known gap #2507）。
- **并发档位**：`MAX_PARALLEL=3` + 全局 `concurrencyPool` 槽位，与批量评估共享一套参数，不为体检单设。
- **无总超时（no batch timeout）**：批量不设总时长上限；单 worker 各自 30 分钟 `killMs` 是硬上限，总时长由用户取消控制。取消时已完成项的台账行保留（append-only 不回滚）。
