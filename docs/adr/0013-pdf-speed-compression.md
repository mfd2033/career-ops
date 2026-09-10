# ADR-0013: 定制简历 PDF 生成提速（引擎不变）

- **Status:** Accepted (2026-09-10)
- **Context:** 在 AI 引擎配置不变（claude + sonnet）的前提下压缩「定制简历 PDF 生成」的墙钟耗时。实测基线（report 252）单条 PDF 定制约 80s。耗时主导是 LLM 定制内容 turn（pdf.md step 6-17 的摘要重写、项目选择、experience 重排、competency grid、关键词注入），渲染环节（build-cv-html → verify-cv-facts → generate-pdf）是纯本机毫秒~秒级噪声。hm-audit（默关，子 agent + web 研究）被排除在提速范围外。

与 ADR-0009 的区别：0009 面向「完整职位评估」（PDF 仅作为其中的延后尾部）；本 ADR 面向「独立定制 PDF」主路径。PDF 是格式受限的最终产物，漏一个 experience/project 就是实的质量缺失，因此提速护栏比评估更强调「不准漏字段」。

## Decision

1. **压缩规则落 `modes/_custom.md`（用户层）**，不落系统层 `modes/pdf.md`。理由同 ADR-0009 决策 1：压缩是用户提速偏好，`_custom.md` 永不随 `update-system.mjs` 覆盖。

2. **主攻 LLM 定制 turn + 压缩 prompt 注入**，量化目标保守 15-25%（基线 80s → 60-68s），只做低风险手段，第二阶段实测有数据后再决定是否压源文件。手段：
   - **源文件一次并行 Read**：cv.md / config/profile.yml / modes/_profile.md / article-digest.md（若存在）/ interview-prep/story-bank.md（若存在）/ modes/_custom.md 同一 turn 全部发出，禁止逐文件串行读。
   - **不重读**：已在上下文的文件不再重读。
   - **相关段注入**：只注入与 JD 相关的段（如只取匹配的项目，不读全量 story-bank）。**压缩仅承诺不全量**——裁剪时必须显式声明「仅注入相关段，未全量读 X」，不做隐性省略。
   - **单选 payload 完整结构**：定制内容分块单轮出，产出即一次写 payload 文件，不再逐段往返确认。
3. **渲染后清单核对（质量护栏）**：build-cv-html 产出 HTML 后，对 accent 关键字段做存在性检查——sections 本地化标题 / candidate.photo / lang（CJK 断行 / RTL）——缺失即报错回退；verify-cv-facts.mjs 继续作为造假 gate 保持不变。目的：机械兜底字段级遗漏，是「相关段注入」引入的漏项风险的补偿。
4. **hm-audit 不射程**（沿用 ADR-0009）：不存在 `--hm-audit` 且 `_custom.md` 未开启时，pdf step 20 直接跳过，不计入提速承诺；若开启则其成本如实计入，不因提速而弱化质量。

## Alternatives considered

- **激进压缩（30%+，含裁剪 cv.md/profile/_profile 源）**：漏字段 → PDF 缺 section 或构建错，质量风险不可控，本版放弃，留待第二阶段有基线数据再评估。
- **改 `modes/pdf.md`（系统层）**：会被版本更新覆盖，放弃。
- **并行渲染多个 PDF**：渲染环节本就是秒级噪声，优化收益封顶，放弃。

## Consequences

- PDF 定制主路径预期 80s → 60-68s（15-25%），主要来自并行读源与不重读（去串行轮次延迟）+ 相关段注入（少 token 进上下文）。
- 质量风险集中在「相关段注入」的漏项，由「压缩仅承诺不全量 + 渲染后清单核对」双护栏兜底。
- 报告结构与最终 PDF 内容完整度保持：只减 turn / token，不减源字段。
- 后续 PDF 定制数据由 ADR-0009 的 `log-eval-timing.mjs` 继续记录 `pdf` step（用户层），可供前后对比与持续监控。