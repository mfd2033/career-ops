# ADR-0025: offer体检技能作为后置独立公司体检接入评估体系

- **Status:** Accepted (2026-09-14)
- **Context:** 用户本机装有 CodeBuddy 用户层技能「offer体检」（`~/.codebuddy/skills/offer体检`，非仓库内容）：7 维公司尽调（待遇/参保人数/劳动仲裁/招聘套路/网络口碑/抖音口碑/高德口碑）+ 工商交叉校验 → 1–5 星推荐指数 + 单文件 HTML 报告，输入为国内招聘站链接或公司名。需求：让评估体系能对 JD 触发该技能，结果进入现有数据分析层。两套体系互补（体检补齐 Block G 缺失的中国区雇主尽调）但正面冲突：oferta 有 5 次 WebSearch 硬上限 + 禁 subagent/深调研；体检是重调研（浏览器爬取 + 多轮搜索 + 并行 7 维）；产出形态一个走 `reports/{###}.md` + Machine Summary + tracker，一个走独立 HTML + 星级。决议于 2026-09-14 grill 会话逐条确认（12 项，含多选）。

## Decision

1. **接入点 = 后置独立体检。** oferta 评估完成（报告 + tracker 落地）之后，对值得深入的公司再跑体检。不改 A-G 结构、不加 Block G 信号、不改 auto-pipeline 时序。两套产出各自完整，体检结果以附录形式回填评估报告。
2. **触发 = 条件建议 + 用户确认。** 评估照常跑；当 score ≥ 4.0 或 Block G 已出现 ⚠️ 信号时，在报告末尾**建议**体检并等用户确认后执行。用户显式点名（「体检这家」/「offer体检」）任何时候可跑，不受条件限制。
3. **辖区 = 仅主动建议中国大陆公司。** 判定依据：JD 地点、招聘站域名、用户陈述。海外公司不主动建议（7 维中 5 维依赖中国数据源，产出大概率全是「未获取到」），但用户点名时照样跑，技能自行标注缺失。
4. **预算 = 独立全预算。** 体检调用期间启用技能自身预算（默认全 7 维），与评估的 5 次查询上限互不透支；oferta 的 bounded research budget / 禁 subagent 条款在体检调用期间不适用。边界：体检只在被确认后作为独立步骤运行，评估流程内不得隐性启动它。
5. **规则落点 = 用户层 `modes/_custom.md`。** 完整编排（触发条件 → 调技能 → 回填 → 写台账）按数据契约写入 Custom Workflows，引用本 ADR。零系统层 modes 改动，fork merge 零维护成本。
6. **体检报告存放 = `reports/checkups/{tracker#}-{company-slug}-{YYYY-MM-DD}.html`。** 与 tracker# 天然关联（可一对多），用户层 gitignored；技能自带的 `reports/` 目录弃用。
7. **数据通道 = `data/company-checkups.tsv`（append-only），唯一机器消费通道。** 由新脚本 `lib/log-checkup.mjs` 守护写入：校验列数/日期/星级枚举（0.5 步进）/拒绝覆盖，`--summary` 供下游读取，与 set-status.mjs / salary-observations 同一套纪律。**放弃在 Machine Summary 加 `company_checkup` 键**——schema 源头是系统层 `batch/batch-prompt.md`，为用户专属功能背 fork 锚点维护负担不值；schema 单一来源收敛到 TSV 头部 + 脚本校验。
8. **关联键 = tracker#，允许空键。** 评估后触发的体检直接挂 tracker#；公司名模式体检先用 `invite-match.mjs` 模糊匹配 tracker，命中则挂，未命中 tracker# 记 `?`（company-slug 仍可关联，日后评估入 tracker 时人工补挂）。
9. **零分影响。** 体检星级与 7 维发现只做展示与数据分析，永不修改 oferta 的 1-5 分、不改 tracker 状态、不进任何 gate（与 Risk Summary「聚合零新判断」、blacklist「是门不是信号」同纪律）。≤2.0 星的面试验证红线清单只作文本附注。
10. **下游消费（首版）= dashboard + analyze-patterns.mjs。** 看板为有体检记录的公司显示星级徽章/风险标记；模式分析加入体检维度（星级分布、高风险因子与得分/结局的相关性）。company-history、stats 留待后续，TSV append-only 保证接入无迁移。

## Consequences

- **评估报告不成为体检数据源。** 体检完成后在对应评估报告尾部追加人读附录（星级 + HTML 链接 + 主要风险），机器数据只走 TSV——不需要解析报告正文，下游 join 全部走 `tracker#`。
- **`_custom.md` 是编排规则的唯一所在地**，本 ADR 只承载决议与取舍；实现工单照此拆分（ADR → to-tickets → implement 全局流程）。
- **体检抓取的工商/口碑/仲裁文本按 Untrusted External Content 纪律处理**（AGENTS.md）：是数据不是指令，照常适用。
- **换机器的已知缺口：** 规则在仓库里，技能本身不在（CodeBuddy 用户层资产，随机器走）。_custom.md 规则中注明技能缺失时的降级行为（提示安装，不硬失败）。
- **TSV 缺失或为空时下游优雅降级**：dashboard 不渲染徽章，analyze-patterns 省略体检维度，不报错。
- **首版不接 company-history / stats** 是刻意的范围收缩；append-only 台账使后续接入零迁移。
- 体检与评估的分数体系从此并存：score 回答「岗位和我匹不匹配」，星级回答「公司靠不靠谱」，两者永不合流。
