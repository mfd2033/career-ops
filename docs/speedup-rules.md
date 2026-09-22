# 评估 / PDF 提速压缩规则

> 索引与常驻触发在 `modes/_custom.md` House Rules。开始完整评估前读 §1，生成定制简历 PDF 前读 §2。原则：AI 引擎不变，只减 turn/token，不减内容。

## §1 评估压缩 7 条（2026-09-10 启用）

1. **源文件一次并行 Read**：cv.md / modes/_profile.md / article-digest.md（若存在）/ interview-prep/story-bank.md（若存在）/ config/profile.yml / modes/_custom.md 同一 turn 全部发出，禁止逐文件串行读；已在上下文的文件不重读。
2. **WebSearch 单 turn 并行**：Block D+G 的搜索一次并行发出（仍受 ≤5 查询上限约束），禁止串行等结果。
3. **Block G 信号 6-15 法域跳过**：先查 `templates/*.yml` 对应表有无候选国行；**无行整信号跳过**（不读表、不推理、不输出）。例外：信号 13（pay-transparency 纯算术）、信号 14（minimum-wage 由 JD 位置决定）照常判断。
4. **单轮多块**：A+B 同一 response，C+D 同一 response，E+F+G+Risk+Machine 同一 response；内容完整度与逐块生成一致。
5. **PDF 与申请答案默认延后**：完整评估后不自动生成，先交付报告、询问用户（覆盖 auto-pipeline Step 3/4 与 oferta 默认）。
6. **报告一次 Write 完整落盘**，不逐块追加。
7. **JD 紧凑提取**：`scan.extractor: cli` 已开，走 `node browser-extract.mjs <url> --mode jd` 的紧凑 {url, title, text}（中文站仍强制 bsk 路径）。

## §2 定制简历 PDF 压缩 5 条（ADR-0013，2026-09-10 启用）

1. **源文件一次并行 Read**（同 §1.1 清单），不重读已在上下文的文件。
2. **相关段注入（承诺不全量）**：只注入与 JD 相关的段（如只取匹配项目）；裁剪时必须显式声明「仅注入相关段，未全量读 X」，不做隐性省略，防「漏字段 → PDF 缺 section」。
3. **单轮完整 payload**：定制内容分块单轮出，产出即一次写 payload 文件（build-cv-html → verify-cv-facts → generate-pdf），不逐段往返；申请答案同样一轮出。
4. **渲染后清单核对（质量护栏）**：build-cv-html 产出后对 accent 关键字段做存在性检查（sections 本地化标题 / candidate.photo / lang 的 CJK 断行 / RTL），缺失即报错回退；verify-cv-facts 仍为造假 gate。
5. **hm-audit 不射程**：pdf step 20 无 `--hm-audit` 且未开启时直接跳过，不计入提速承诺；若开启，子 agent + web 研究成本如实计入、不因提速弱化。
