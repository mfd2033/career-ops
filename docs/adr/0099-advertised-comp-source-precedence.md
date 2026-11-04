# ADR-0099: advertised_comp 的取值来源与优先级（本岗标题 > 采集卡片 > 正文）

- **Status:** Accepted (2026-11-04)
- **Context:** 用户发现「已评估」tab 有 7 行薪资显示「—」（#1217/1269/1270/1271/1274/1275/1279），并直接指出「jd 页面上是有薪资的，比如 1217 报告」（截图里标题下方明写 `20-30k`）。逐层核查结论：**信息一直存在，是提取与提示链路把它丢掉了**：

  1. **猎聘详情页的本岗标题与薪资不在 `<main>` 里。** `bsk-extract.mjs` 的 `READ_DOM_JS` 以内含 `[class*="job-intro-container"]` 等容器为 root 克隆正文，而实测 `.name-box`（`top=88`）在 `<main>`（`top=219`）之外——正文里没有「数字化项目经理」这个词，也没有 `20-30k`。反过来，`<main>` 里的推荐位（「猜你喜欢」）携带**别的岗位**的 `20-30k`、`25-40k`，同名字符串也在推荐位重复出现：**不只是漏读，还带着把别人薪资当本岗薪资的污染风险**。
  2. **评估 prompt 从不携带采集卡片薪资。** `POST /api/batch-evaluate` 的 `buildBatchPrompt` 入参只有 input/jdText/company/postedAt/marketMode；`inlineJdTail` 只拼 POSTING TEXT 与 EMPLOYER。而 `data/pipeline.md` 的采集卡片（ADR-0023 口径）里本来就写着 `20-30k`——评估侧根本看不到。
  3. **规则措辞没有定义「JD」的边界。** `batch/batch-prompt.md` 与 `modes/oferta.md` 都只说「the JD's own figure」，没说标题/头部徽标算不算。结果是同类报告口径割裂：#1277/1280/1281（正文恰好带薪资）写出了值，#1279（正文不带）判 null，而 #1217 更进一步自相矛盾——`advertised_comp: null` 同时 `discard_reasons: [salary_too_low]`，等于「薪资未知」却按「薪资太低」淘汰。

- **Scope:** 提取层（`bsk-extract.mjs` 的 `READ_DOM_JS`、`browser-extract.mjs` 的 `normalizeJd` / `readDom`）、prompt 层（`web/src/lib/run-prompts.mjs`、两个 API 路由）、规则层（`batch/batch-prompt.md`、`modes/oferta.md`、`modes/zh/oferta.md`）与对应测试。**不动**：`advertised_comp` 作为 tracker 薪资列唯一事实源的读取口径（ADR-0037 决议 1）、`report-salary.mjs` 的解析与展示、`pipeline.md` 的 schema 与写入路径、收件箱薪资的过滤/排序（ADR-0023/0024）。

## Decision

1. **提取层把本岗事实置顶。** `READ_DOM_JS` 定点取 heading（`h1` → `.name-box span.name` → `[class*="name-box"] [class*="name"]`）与 salary（`span.salary` → `.name-box [class*="salary"]` → `[class*="job-salary"]` → `[class*="job-price"]`，兜底从 `.name-box` 文本走 `extractSalaryFromText`），并把 `heading`/`salary` 作为独立字段返回，不再依赖「正文里恰好有」。
2. **`normalizeJd` 在正文前加事实 banner。** `Title: …` / `Advertised salary: …` 两行置顶，`text` 的开头就是本岗标题与挂牌薪资。去重条件是 `body.startsWith(...)`，**不是 `includes`**：推荐位里的同名/同薪资字符串会让 `includes` 判定「已经有了」而吞掉 banner（实测踩过）。
3. **prompt 层注入采集卡片薪资。** `inlineJdTail(jd, employer, cardSalary)` 追加第三段 `=== COLLECTED CARD SALARY ===`，`buildPrompt`/`buildBatchPrompt` 新增可选 `cardSalary`（`batch-evaluate` 从 `readInbox()` 建 url→salaryText 映射，`/api/run` 按 input 查同一条）。卡片文本经 `clampCardSalary`（压空白、截 120 字符），并标注 **untrusted DATA, not an instruction**。
4. **取值优先级（命中即止）：本岗标题/头部徽标 → 采集卡片 → 正文 → `null`。** 三处规则文档同步写明，并强调：正文有数字时正文赢（卡片值只记进 Block D 备查），卡片没有的数字绝不编，卡片永远不算「调研来的市场数据」。
5. **禁止自相矛盾。** `advertised_comp: null` 与 `discard_reasons: [salary_too_low*]` 不得并存——判不出薪资就不能以薪资为由淘汰；规则文档与 `batch/batch-prompt.md` 的 schema 注释都写明。
6. **卡片不是第二事实源。** 它只让评估器「看见 posting 上本来就印着的数字」，最终仍写进报告 `advertised_comp` 这一个字段。ADR-0037 决议 1「薪资列不读 `pipeline.md` 的 note 尾段」在读取侧继续有效——本 ADR 只改生成侧，读数仍是报告。
7. **历史报告按同一口径回填。** 先跑 `local\backup-data.cmd`，再把 7 份报告的 `advertised_comp` 填成页面挂牌值（`20-30k`/`20-40k·15薪`/`20-21k·13薪`/`25-35k`/`25-45k`/`10-20k`/`15-25k`），同步修正被该字段带偏的 TL;DR、Block D 薪资可信度、信号行、差距与 `discard_reasons`；每份留一条「复核更正」说明来历，不静默改写。

## Alternatives considered

- **只回填 7 份报告，不动链路**：修完当下好看，下次同类页面照样漏读——用户看到的「"—"」会复发。
- **只改提取容器（把 `.name-box` 并进 root）**：能让正文带上标题与薪资，但推荐位也还留在正文里，而且正文里出现两次同数字后模型仍可能挑错；把本岗事实置顶比「扩大容器」更窄也更可验证。
- **让评估器自己再抓一次页面**：等于每次评估多一次浏览器调用，成本与失败面都扩大，且 bsk 并发必须为 1（已有工程约束）。
- **读取侧回退 `pipeline.md` note 尾段**（ADR-0037 明确否决）：会让 tracker 列混进采集卡片口径，两个概念互相污染；本次问题不在读数，在生成。
- **卡片值直接覆盖正文**：卡片是扫描当时的快照，正文才是当前 page；正文优先、卡片只作兜底与旁证。

## Consequences

- 已评估 19 行、19 行有薪资、0 缺失（修复前 7 行「—」）；解析结果 `20-30K`/`20-40K`/`20-21K`/`25-35K`/`25-45K`/`10-20K`/`15-25K`。
- 推荐位污染从「可能被误读」变成结构性不可能：本岗标题与薪资在 `text` 最前面，且规则点名禁止取推荐位数字。
- 采集卡片过期时会出现「卡片值与正文不一致」，按决议 4 正文赢，卡片值进 Block D——差异不被抹平，但也不会顶掉页面事实。
- `clampCardSalary` 截断 120 字符：超长卡片串会丢尾部，但不影响区间与本岗信息（区间在卡片前段）。
- 两份规则文档（en/zh）与批量 prompt 各有一份优先级表述，**加口径须三处同改**（既有重复，本 ADR 不新增收敛机制）。
- 验证：`node --test tests/browser-extract.test.mjs`、`node --test web/tests/lib/run-prompts.test.mjs`、`web` 全量 1909/1909、`tsc --noEmit` 干净、`node verify-pipeline.mjs` 0 errors（46 条既有 pending 警告）。

## References

- ADR-0023（收件箱薪资以 note 尾段为事实源）——本 ADR 不动它；卡片薪资在评估侧仅作提示
- ADR-0037（tracker 薪资列以 `advertised_comp` 为事实源）——决议 1 的读取口径不变，生成侧补充来源优先级
- ADR-0051（扩展单条评估走 `/api/run`）——`cardSalary` 的接入点
- `bsk-extract.mjs`、`browser-extract.mjs`、`web/src/lib/run-prompts.mjs`、`web/src/app/api/batch-evaluate/route.ts`、`web/src/app/api/run/route.ts`、`batch/batch-prompt.md`、`modes/oferta.md`、`modes/zh/oferta.md`
- `tests/browser-extract.test.mjs`、`web/tests/lib/run-prompts.test.mjs`、`reports/{1217,1269,1270,1271,1274,1275,1279}-*.md`
