# ADR-0089: 工作器报告号——checkup 纳入数字回退，台账行显式携带 reportNum

- 状态：采纳（2026-10-26）
- 决策人：用户（web 任务主线）
- 关系：部分修订 ADR-0018 决议 5；沿用其决议 1/4 的「捕获优先于 URL 反查」口径

## 背景

`/jobs` 列表的报告号列（`ReportNumLink`）有部分任务空白。按 ADR-0018，报告号有四个来源：捕获的 `reportNum`（仅 pdf 写入）、`input` 是 URL 时 join `/api/report-status`、池卡的 `#N` 副标题、以及只对 `kind === "pdf"` 生效的裸数字回退。

两处遗漏导致空白：

1. **checkup 的号没被认出来**。checkup 工作器的 `input` 是 tracker 行号（`checkup-request-button.tsx:77`），而 tracker 行号就是报告号（`/api/report-status` 的契约：`reportNum` = 该行号 = `/report/{n}`）。网页发起的 checkup 本地卡靠 `subtitle: "#N"` 侥幸有号，但**台账行**（`recordEnd` 写 `input = tracker#`、无副标题）解析不出来。
2. **台账行丢了捕获号**。`ledgerRunsToCards`（`web/src/lib/ledger-display.mjs`）从不透传 `reportNum`，服务端 `recordEnd` 也不写它。于是别的页签/扩展/脚本发起、本页签没有本地卡的单任务，跑完落台账后只能退回「URL join tracker」，pdf 与 checkup 直接无号。

ADR-0018 决议 5 当年把这类空白判为设计（"不扩到其它种类"），并否决过"把数字 `input` 直接当报告号"，理由是怕未来新 kind 复用数字 `input` 时静默错跳。

## 决策

1. **数字回退扩为闭合白名单**：`report-num.mjs` 的 `NUMERIC_INPUT_KINDS = {pdf, checkup}`。checkup 的 `input` 按自身启动契约就是 tracker#（= 报告号），这不是"按 kind 猜 input 语义"，而是该 kind 的 input 定义；白名单保持闭合，新 kind 默认不享受回退——正面回应 ADR-0018 的顾虑。
2. **台账行显式携带 `reportNum`**：单任务 `recordEnd` 写入该字段（pdf / checkup 取 `input`，evaluate 取收尾 `reconcile` 推得的号；凑不出即不占位），`ledgerRunsToCards` 原样透传到卡。解析优先级不变——捕获号最先（ADR-0018 决议 1/4）。
3. **维持 ADR-0018 决议 5 的其余部分**：`research` / `fix-portal` 不产报告，无号；`batch-evaluate` / `batch-checkup` 汇总行不挂单号（一条对多份，逐项号在 child items，ADR-0046 §3）。

## 范围（不动）

- 不改状态机、不动 tracker 写路径；识别不许拿别的字段凑号。
- `batch-checkup` 汇总行的 `input` 是 `#n +k` 摘要，不是单一号，故不纳入白名单。
- 评估用时口径（ADR-0016）不变：解析出号 ≠ 显示用时。

## 后果

- checkup 单卡与其台账行、pdf 台账行、evaluate 台账行（推得号时）在 `/jobs` 列表、托盘、`/jobs/{id}` 三处都能显示 `#N`。
- 纯台账（跨页签/扩展发起）任务不再依赖"URL 恰好命中 tracker 索引"才有号。
- 测试锁定：`web/tests/lib/report-num.test.mjs`（白名单含 checkup、仍排除 fix-portal/research/batch-checkup）、`web/tests/lib/ledger-cards.test.mjs`（台账 `reportNum` 透传、缺失不占位）。