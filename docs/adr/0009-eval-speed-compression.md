# ADR-0009: Evaluation Speed Compression (engine unchanged)

- **Status:** Accepted (2026-09-10)
- **Context:** 在 AI 引擎配置不变（claude + sonnet）的前提下压缩完整职位评估的墙钟耗时。实测基线（报告 252）单条全管线约 343s，其中 A-G 评估+报告约 187s、PDF 定制约 80s。主要成本是 LLM turn 数 × 每 turn 延迟，以及二次 LLM 大活（PDF 定制）。

## Decision

1. **压缩规则落 `modes/_custom.md`（用户层）**，不落系统层 `modes/oferta.md` / `_shared.md`。规则只减 turn 不减内容：源文件一次并行 Read、Block D+G WebSearch 单 turn 并行、Block G 信号 6-15 候选国无法域行整信号跳过、A+B / C+D / E+F+G+Risk+Machine 单轮多块、报告一次 Write、不重复读。
   - 理由：`_custom.md` 永不随 `update-system.mjs` 覆盖（AGENTS.md Data Contract），压缩是用户自己的提速偏好；系统层文件会被版本更新重置，每次更新后重写不划算。
   - 代价：系统更新若改变评估指令结构，`_custom.md` 里的压缩规则可能与新结构错位，需人工核对。

2. **PDF 与申请答案默认延后（需确认才生成）**。完整评估后先交付报告，向用户询问是否生成 PDF/申请答案；确认后 CV 定制内容单轮输出完整 JSON payload，再走 `build-cv-html.mjs` → `verify-cv-facts.mjs` → `generate-pdf.mjs`。
   - 理由：PDF 定制是独立的二次 LLM 大活（约 80s/条，占比约 23%），且低分岗（<4.0）本就不推荐投递，自动生成 PDF 常属浪费。延后把主路径从"全管线"变为"报告即时交付"，用户按需取 PDF。
   - 代价：需用户额外一步确认；已生成的报告 PDF 状态为 ❌ 直到用户要求（tracker 与 dashboard 的 PDF 列如实反映）。

3. **`scan.extractor: cli` 开启**：JD 提取走 `browser-extract.mjs --mode jd` 的紧凑 {url,title,text}，少 token 进上下文（中文站仍强制 bsk 路径）。

4. **`batch/batch-prompt.md` 同步**（系统层）：批量 worker 指令加入同样压缩规则 + 耗时埋点；PDF 仍受 `auto_pdf_score_threshold` 门控（batch 无交互确认，保留自动生成语义）。

5. **评估耗时埋点**：新增 `log-eval-timing.mjs`，每次评估按固定步骤集写 `data/eval-timings.tsv`（用户层），供前后对比与持续监控。

## Alternatives considered

- **改 `modes/oferta.md`/`_shared.md`（系统层）**：会被版本更新覆盖，放弃。
- **PDF 保持自动只压内部 turn**：主路径仍被 PDF 拖尾，放弃。
- **派并行子 agent 拆块评估**：与 `_shared.md`"不嵌套子 agent、研究内联 bounded"冲突，放弃。

## Consequences

- 单条主路径（无 PDF）实测 343s → 173s（含同 JD 上下文复用，真实新 JD 收益会略小）；PDF 延后省约 80s。
- 报告结构与内容完整度不变（护栏：只减 turn 不减内容）。
- 后续每次评估自动记录耗时，可继续量化验证。
