# 数据层开发铁律（pipeline / tracker / 评分入口）

> 触发在 `modes/_custom.md` House Rules：动新增写入路径、评分入口、pipeline.md 写回、跨层 URL 匹配前必读对应小节。事故背景见 `docs/fork-ops-history.md` §2。

## §1 新写入路径必须数据全生命周期审计（强制，2026-09-12）

- 新增任何创建记录的流程（web API / 脚本），上线前三问自查：「读哪些数据文件、写哪些、由谁标记完成」。
- 凡 readInbox 会展示的记录，必须有对应的完成标记路径——统一走 `reconcile-pipeline.mjs --entry <num>|<url>`。
- 教训：/api/batch-evaluate 只写 reports/tracker-additions 并 merge 进 tracker，从不写 pipeline.md，导致评完的 JD 永远滞留收件箱（`- [ ]` 行无人标记）。

## §2 pipeline.md 读-改-写（强制，2026-09-12）

- 写回必须用 `withPipelineLock`（pipeline-lock.mjs），且基于**锁内新读**的内容、按 URL 单元重定位。
- 禁止拿流程开始时的快照按行号整文件写回：批量流程耗时数分钟，期间 scan 并发追加会移位行号，旧快照整写回既丢新行又把已处理行打回 `- [ ]`。
- 找不到目标行就不动并告警（参照 batch-evaluate-gemini.mjs 现行实现）。

## §3 跨层 URL 匹配（强制，2026-09-12）

- 任何跨 pipeline 行 / report `**URL:**` 头 / tracker 行 / web 请求体的 URL 匹配，必须「原始字符串 + `url-key.mjs normalizeUrl` 键」**双查**——同一 URL 常见差异：http/https、utm 跟踪参数、`<尖括号>` 包裹。
- 禁止纯字符串精确匹配，否则条目困收件箱或重复入账（reconcile-pipeline.mjs 已按此实现，新增匹配照抄）。

## §4 新增评分入口必须复用 batch-evaluate 管线（强制，2026-09-14）

- 任何新 JD 评分入口（web API / 脚本 / mode / 插件）**禁止自建**「报告落盘 + tracker 合并 + pipeline 收尾」，必须复用现有管线：报告按 `reports/N-*.md` 落盘，结果入账（batch-state.tsv 或 `reconcile-pipeline.mjs --entry` 收尾）。
- 同一语义（"这个 JD 评过了"）禁出第二份实现——历史根因即 web 与批处理各写一份、只修了一份。
- 兜底自愈：`node reconcile-pipeline.mjs --from-tracker` 按 tracker 报告 `**URL:**` 头全量扫描，把任何入口评过但滞留收件箱的行收进 Processed；每次批量评估后及定期建议跑。

## §5 匿名雇主 slug（用户层策略，ADR-0004）

- 猎头代招、终端雇主匿名（`company` 写 `?` sentinel）时，报告与 TSV 文件名 slug 一律用文件名安全的 `confidential-{机构或地点}`（字符集 `[a-z0-9-]`），真实雇主描述只留 `notes`；绝不把 `?` 或原始 company 字段插进文件名。
- 「第 8 列链接须与落盘文件名逐字一致」属系统层正确性，权威见 `batch/batch-prompt.md` Step 5；`?` sentinel 与 `Via:` 字段语义见 `docs/adr/0004-unknown-employer-policy.md` 与 `docs/glossary-unknown-employer-policy.md`。
