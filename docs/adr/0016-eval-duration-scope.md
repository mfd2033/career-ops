# ADR-0016: 评估用时的口径——只计到报告交付，不含延后的 PDF/answers/tracker

- **Status:** Accepted (2026-09-11)
- **Context:** web 端工作器卡片与流水线要展示"评估用时"（数据源：`data/eval-timings.tsv` 耗时埋点）。埋点步骤集为 extract/liveness/eval/report/pdf/answers/tracker，其中 PDF 与申请答案受 **PDF 延后**（ADR-0009）约束：可能缺席，也可能在用户确认后**数小时**才补跑（实测数据中存在孤立的 `pdf` 行，与其原评估完全脱节）。

## Decision

**评估用时 = 最近一次评估会话中、至报告交付（extract/liveness/eval/report）为止的各步墙钟之和**；延后补跑的 pdf/answers/tracker 不计入总数，但在 `/pipeline/{n}` 的分步明细中可见。会话按 `extract` 行开启切分（复评自然成新会话，取最近一次；liveness 总是跟随 extract，不作起点，否则每个正常会话都会被切成两半）；无起点的残缺会话照常求和显示；不含报告交付步骤的孤立行（如 lone `pdf`）视为无评估用时，显示 `—`。

理由：该口径与 worker 卡片 done 时刻的实时 elapsed 语义**天然对齐**（PDF 延后模式下卡片在报告交付时即结束），数字含义清晰（"评估出这份报告花了多久"），且避免了把数小时后的 PDF 行归并回原会话的复杂聚类逻辑。代价：列表数字会小于用户全程感受的墙钟（含延后 PDF），这也是本 ADR 存在的原因——防止后来者把"缺了 PDF"当 bug 修掉。

## Alternatives considered

- **全步骤求和**：完整还原总消耗，但延后 PDF 的会话归属需要时间窗聚类（阈值难定），且与 worker 实时时长语义冲突，放弃。
- **时间间隔聚类**（如 30 分钟无行即新会话）：被 PDF 延后直接击穿——同一次评估的 pdf 行可迟到数小时，放弃。

## Consequences

- `web/src/lib/eval-timings.mjs` 是口径的唯一实现（`DURATION_STEPS` 白名单），配 `web/tests/lib/eval-timings.test.mjs` 锁定。
- `/jobs`、`/pipeline` 列表展示该口径；`/pipeline/{n}` 与 `/jobs/{id}` 展示最近会话的分步全量（含未计入步骤）。
- 若未来要"含 PDF 的全流程耗时"，应作为**另一个指标**并列展示，而不是改本口径。
