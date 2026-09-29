# ADR-0068: 收件箱关键词条（零 token 提炼 + chip 过滤）

- **Status:** Accepted (2026-09-29)
- **Context:** 需求（2026-09-29 grill 会话，四轮问答全部锁定）：「求职管道页面的收件箱增加关键词功能，基于收件箱的 JD 提炼关键词，点击关键词显示对应的 JD」。现状与约束：

  1. **收件箱行没有 JD 正文**：`data/pipeline.md` Pending 段每行只有 `URL | 公司 | 职位 | 地点 | 薪资 | note`。正文只存在于两处归档：`jds/*.md`（apify 插件抓取时写的 frontmatter + 原文，含 `url:` 字段可直接关联）与 `reports/*.md`（已评估行才有）。
  2. **评估报告已强制带现成词节**：`modes/oferta.md` 规定每份报告末尾有 `## Keywords extracted` 节（"list of 15-20 keywords from the JD"），实测已是中文 JD 侧关键词（、分隔）。已评估行的 LLM 级中文关键词**零新成本可得**。
  3. **中文关键词的零 token 障碍**：现有抽取器 `jd-skill-gap.mjs`/`skill-extract.mjs` 的 `SKILL_TOKEN_RE` 只捕获大写开头英文 token，对中文 JD 无能为力——纯免费路线必须有一份显式词表做词典匹配。
  4. **正确性红线（grill 中确认）**：报告里除词节外还有大量 AI 评估正文（Block B "CV 对应"列等）。若对报告全文做匹配，cv.md 的用词会经评估文章措辞**反向污染**命中集（候选人会什么，什么就"命中"）。
  5. **工具条刚完成密度改造**（2026-09-26，facet-chips.tsx 注释）：三行筛选收敛为一行工具条，收件箱在定高布局（ADR-0011）下换回垂直空间；再往工具条里塞一组 chip 会倒退。
  6. **收件箱 facet 的两种持久化惯例并存**：视图型过滤（tab/分数/公司/搜索 `q`）走 URL（ADR-0067 上下文链），设置型开关（薪资下限/未评分/按薪资排序）走 localStorage（ADR-0010/0023/0024）。
  7. **新用户层文件有登记义务**：`config/` 下新增个人可编辑文件要进 `DATA_CONTRACT.md` 用户层表和影子备份白名单（`local\backup-data.cmd` 路径清单 + `docs/data-backup.md`），否则不进任何版本控制。

- **Scope:** web 层四处（`career-ops.ts` 服务端关键词装配、`inbox-keywords.mjs` 纯模块、`inbox-triage.tsx`/`keyword-bar.tsx`/`triage-row.tsx` 前端、i18n `inbox.*` 新键）+ 文档三处（DATA_CONTRACT、data-backup、backup-data.cmd 白名单）+ 新文件 `config/keywords.example.yml`（系统层）。**不动**：`pipeline-order.mjs` 共享过滤链与 `buildContextQuery`（关键词只作用于 INBOX 行集，收件箱行没有报告详情页 prev/next 导航上下文，无需 ADR-0067 式全链透传）、tracker 表其他标签、评估模式与报告格式、`modes/_shared.md`。

## Decision

1. **行级关键词 = 两个来源的并集，服务端一次装配**（`pipelineSummary` 随 `InboxJob.keywords` 下发）：
   - **已评估行**：该行 URL 命中的 tracker 报告（`readReportFacts` 同一次读盘顺带解析）`## Keywords extracted` 节的词表——直接采信 LLM 提炼，不重算、不再花 token。
   - **所有行（含未评估）**：用户词表对 `公司 + 职位 + 地点` 文本做词典匹配；行 URL 若能关联到 `jds/*.md` 归档（按归档 frontmatter 的 `url:` 归一键，或行本身是 `local:jds/…` 路径）则对归档正文一并匹配。
   - **红线**：报告其余章节（AI 评估正文）一律不参与匹配（Context 4）。
2. **词表 = 运行时三源并集 + 用户增量文件，不做一次性物化**：种子在每次页面装配时现取——portals.yml `title_filter.positive` ∪ cv.md Skills 节技能词 ∪ `skill-extract.mjs` 的 `SKILL_TOKENS` 全集（按源码文本解析并做与 `DISPLAY` 相同的去转义清洗，解析失败降级为空集不阻塞页面）；`config/keywords.yml`（用户层，可不存在）只做增量补充，另支持 `exclude:` 表抑制词节里的噪声词（如地名"郑州招聘"）。不把种子一次性写进 keywords.yml 快照——那会让用户文件与 title_filter/cv.md 的演化永久漂移。
3. **点击 = 过滤收件箱列表**，不是浏览面板也不是跳转：选中 chip 后列表只保留行级关键词命中任一的行（**chip 之间 OR**）；与 `q` 搜索框及来源/资历/新鲜度/薪资等其他 facet 之间 **AND** 叠加，与现有 facet 的组合语义同构。
4. **展示 = 工具条下方独立可折叠关键词条**：按命中行数降序取前 12 枚 chip（带计数），尾部「展开全部」就地展开（组件内状态，不进 URL）；行数为 0 的词条不显示；无可见关键词时整条隐藏。**计数口径（2026-09-29 修订）**：counts 基于「通过其余全部生效 facet 的行集」计算，chip 数字恒等于点击后的匹配行数。原口径「基于未隐藏全部 pending 行、不随其他 facet 波动」已废弃——`unscoredOnly` 默认开（ADR-0024）的现实中，它会产出「计数 1、点击 0 匹配」的死 chip（已评分行的词节词进不了未评分集，用户实例：「无人驾驶」），与 ADR-0067「n=0 不做死交互」纪律相废；诚实联动优先于 chip 集不闪跳。
5. **持久化 = URL 参数 `?kwd=词1,词2`**：视图型筛选，跟随同页 tab/`q`/company 的 URL 惯例（ADR-0067），支持深链分享（"全部 RAG 岗位"）与前进/后退恢复，assistant 经 `navigate` 天然可用。词表词条禁止含逗号与顿号（加载时校验丢弃，`config/keywords.yml` 同理）；解析时对 `、，,` 统一归一。`anyActive`/「清除」按钮一并纳入 kwd。
6. **行内只高亮命中词，不常驻关键词 chip**：关键词过滤生效时，行上 `公司 · 职位` 文本中的命中词以 `<mark>` 级高亮解释"为什么筛到它"；来自报告词节而标题文本中不出现的词不做行内显示（避免为每行发明第二个关键词展示面）。grill 中明确否决了行上常驻 chip 的形态。
7. **生效范围 = 仅 INBOX 标签**：切到任何其他 tab 关键词条隐藏、过滤不作用（pending 行集与 tracker 行集本就是两套渲染面）。
8. **成本姿态 = 纯免费**：整个链路（服务端装配 + 客户端过滤）零 LLM 调用，关键词条沿工具条现有 CostBadge "free" 语言，不新增成本徽标。
9. **新用户层文件登记（三处同步）**：`config/keywords.yml` 进 `DATA_CONTRACT.md` 用户层表；进 `local\backup-data.cmd` 白名单路径清单与 `docs/data-backup.md` 白名单段。`config/keywords.example.yml`（格式说明 + 初始中文种子清单）为系统层，供用户复制起步——服务端**从不自动创建** keywords.yml，缺失时仅用三源种子。
10. **i18n**：全部新键 en/zh 成对（`clusters/inbox.ts`），用户可见文案简体中文；技术词形（chip 上的关键词本体）原样显示不翻译。
11. **死词自动剪枝（2026-09-29 补，用户报修）**：批量删除/评估把选中词的命中行清空后，残留的死 `kwd` 会把页面锁在「0 匹配」而数据其实还在。现在 `InboxTriage` 在 pending 行集变动后剪掉「不再命中任何 pending 行」的选中词（存活集含 hidden 行——skip 可撤销不该被剪），部分存活只剪死词、幸存词保留选中态；纯逻辑在 `deadKeywords`（单测上锁）。

## Alternatives considered

- **评估时新花 token 提炼关键词**：被否——`## Keywords extracted` 已在每次评估中免费产出，重复建设。
- **报告全文匹配**：实现最简单，但 AI 评估正文造成 cv 用词反向污染 + 已评估行"关键词富"系统性偏差。
- **n-gram 频率自动统计（零词表）**：零维护但中文分词噪声大（"经验/职责/公司"都会成词），且无法表达"什么算关键词"的用户意图。
- **并入现有工具条尾部 / 行上常驻 chip**：前者倒退刚完成的一行密度改造；后者被展示决议 4/6 的"全局汇总 + 只高亮"取向否决。
- **localStorage 跟随薪资下限惯例**：省事，但关键词选择是视图型状态，丧失深链与下钻能力，与同页 tab/q 的 URL 语言不一致。
- **种子一次性物化进 keywords.yml**：用户文件与三源演化漂移，且引入"服务端写用户层文件"的副作用（Windows 文件锁、影子备份纪律全被牵动）。
- **全管道页通用（tracker 表也按关键词筛）**：需要 tracker 行↔报告关联的第二套实现并进 `orderApplications` 共享链，工作量翻倍，需求原话只点名收件箱。

## Consequences

- **`InboxJob` 形状加长**（`keywords: string[]`）：所有 inbox 消费方（InboxTriage、registry 的 evaluateCompany 匹配、whats-new 过滤等）拿到的行对象多一个服务端已装配字段，只读消费不破坏现有逻辑；流水线页每次加载多解析「pending 行 URL 交集内」的报告词节与 jds 归档（一次性读盘已并入现有 `readReportFacts` 通道，jds 归档仅十余文件，成本可忽略）。
- **`skill-extract.mjs` 成为 web 服务端的文本级依赖**：解析其 `SKILL_TOKENS` 源码块的结构（引号数组 + 注释剥离），该文件改格式会静默降级为空集——由 `inbox-keywords.test.mjs` 的解析用例对当前格式上锁；上游改动此文件时测试先红。
- **词表维护成为用户侧持续行为**：想加"Agent"、"出海"这类新词就改 `config/keywords.yml`；词表文件进影子账本后，改坏了可回滚。
- **`kwd` 参数不进报告导航上下文**：从收件箱点进任何报告页都不携带关键词过滤——这是明说的不做（收件箱行无详情页，将来若要"已评估区按关键词浏览"需新 ADR 把维度并入 `normalizeContext` 全链）。
- **高亮只解释标题文本命中的部分**：命中报告词节的行可能"看不到为什么被筛出来"，行上不加解释面是明示的取舍。

## References

- ADR-0067（分析页下钻 + URL 上下文七参数）——`kwd` 借鉴其视图参数语言但**有意不进**共享过滤链的边界决策来源。
- ADR-0010/0023/0024（收件箱 facet 的 localStorage 惯例与默认开关）——关键词选择与其分野（视图型 vs 设置型）的对照。
- ADR-0011（管道定高布局）——关键词条必须可折叠、默认只占一行的空间纪律来源。
- ADR-0039 决议 5 / facet-chips 密度改造——「清除」chip 与不跳位视觉语言。
- `modes/oferta.md` L627（`## Keywords extracted` 节格式）——已评估行词源的系统层契约。
- docs/data-backup.md——影子备份白名单登记义务。
