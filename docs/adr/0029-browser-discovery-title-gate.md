# ADR-0029: 探索页采集门补全——标题门、城市门偏好回落与存量清理

- **Status:** Accepted (2026-09-16)
- **Context:** 收件箱 `data/pipeline.md` 积到 Pending 1,922 行，其中 **1,871 行**是探索页 browser 模式确认入管产生的（带 `note: browser · …`），且**一条都没被评估过**（Processed 里 0 行带该标记）。逐条看下去，内容与用户的求职意向无关：叉车司机【安庆】、食品化验员【宁波】、行政专员【温州】、财务主管【苏州】、Java/C++ 开发工程师、兼职与实习岗。根因不是关键词没调好，而是**采集层缺少第三道门**：browser 模式在落地前只套两道门——城市门（`matchesBrowserCity`）与薪资门（`applyBrowserSalaryGate`），搜索 URL 里带的关键词只作用于站点检索，页面上的「相关推荐／猜你喜欢」位照单全收。更讽刺的是这份词表早写好了：`portals.yml` 的 `title_filter`（25 positive + 29 negative）被 CLI 扫描器遵守、也被 `seedExploreFilters`（`portals.ts:77-80`）播种进 `ExploreFilters.positive/negative`，**只有 browser 模式不消费它**。ADR-0021 把「采集」与「入管」分成两个时刻是对的，但它把噪声的出口留在了「确认入管」那一步——结果区默认全选，噪声就整页搬进收件箱。决议于 2026-09-16 grill 会话逐条确认（四轮共 14 项）。
- **Related:** ADR-0007（扩展驱动探索页扫描；其 E4 声称猎聘/BOSS 的城市过滤「复用 web 端 `matchesBrowserCity`」，代码里从未接上）、ADR-0021（采集只记「见过」）。

## Decision

1. **采集落地门加第三道——标题门（title gate）。** 位置与城市门、薪资门并列：在结果集生成前过滤，被毙掉的岗位不进结果区。实现为 `web/src/lib/browser-search.mjs` 里的纯函数，bsk 服务端路径（`web/src/lib/core/browser-scan.ts` 采集循环）与扩展页侧路径（`web/src/components/explore/explore-provider.tsx` 取回处）共用同一份实现——沿用薪资门 `applyBrowserSalaryGate` 已确立的「两条 driver 共享一个纯函数」模式。
2. **语义与词表单一来源。** 标题门判据 = `portals.yml` 的 `title_filter`，语义与 CLI 扫描器**完全一致**（positive 命中 ≥1 **且** negative 0 命中，`title-keywords.mjs:166-168`）。词表不从 browser 模式另起一套：调词表一处生效，CLI 与探索页永不漂移。
3. **匹配面 = 站点给的原始 title，不做剥尾。** 猎聘卡片标题尾巴里的薪资/经验/学历一并参与匹配。代价（脏串可能带出意外命中）由干跑清单兜住：清理脚本须把「剥尾与不剥尾判定不同」的行单独列出，供日后决定是否补一条剥尾规则。
4. **被毙者留痕两处。** ① 写一行 `data/scan-history.tsv`，`status=skipped_title`——沿用既有取值（`modes/scan.md:264`、实现参照 `scan-interamt.mjs:325`）；② 探索页结果区留一个只读的「已过滤 (N)」折叠区。前者回答「这条是哪次搜索带进来的」，后者回答「是不是误杀了我要的岗」，两个问题的时间尺度不同，缺一个都会回头再补。
5. **折叠区只读，不可救回。** 要放行必须先改词表再重扫——这样 `scan-history` 里那行 `skipped_title` 与收件箱事实永远不冲突；若允许就地救回，台账会出现「记着被毙、行却进了收件箱」的矛盾记录，日后无法用台账复盘。
6. **城市门语义改为偏好回落。** 城市条件留空时回落到 `location_filter.allow`（本次条件覆盖长期偏好，不设则用偏好）；真·全国搜索由城市下拉里新增的**显式「全国（不限城市）」项**表达，哨兵值走既有 `city` 参数（`browserToParams`）。「未设置」与「明确不限」在界面上必须可区分。
7. **补接扩展路径缺失的城市门。** `matchesBrowserCity` 全仓只有 `browser-scan.ts:167` 一处调用点；扩展路径只套了薪资门，`zhCity` 在那里仅用于构造搜索 URL。本次一并接上，与薪资门同一接线点——否则决议 6 在扩展路径上是空转，且 ADR-0007 E4 的注释继续与代码不符。
8. **存量清理用同一把尺子，脚本住 fork-local 层。** 对 Pending 里**带 `note: browser` 的行**逐条重判：城市门 = `location_filter.allow`（郑州），标题门 = 当前 `title_filter`。先出干跑清单供过目，备份后批量删待评行（已 Processed 的行不动）。**豁免边界：机器只删机器写的行**——不带 `note: browser` 的 51 行（手粘 URL / 早期 WebSearch 行）一律不参与，它们没有 title，机器判不了「符不符合关键词」。一次性清理脚本放 `local/`（ADR-0022），标题门这类通用能力进系统层，不为一次性操作新增长期 FORK-LOCAL 锚点。
9. **词表本轮不动，先量后调。** 干跑清单须产出一份**按频次排序的候选词表**（含 positive 漏放样例如「软件实施工程师」、negative 缺词样例如「兼职」），供下一轮一次性应用。
10. **词表维护回路本轮不做。** 从结果里一键「加入 negative」的按钮，其形态取决于干跑清单里的真实误杀／漏放样本；没有样本前设计回路只能猜。
11. **连带修复共享匹配规则的 CJK 词边界缺口（prefactor，工单 06）。** `title-keywords.mjs` 的词字符类含 `\p{L}`，而汉字也是 `\p{L}`——于是 2-3 字母缩写按词边界锚定时，`IT` 匹配不到 `IT项目管理`（`HR`/`AI` 同理）。后果是中文标题几乎全数匹配不上、只有拉丁标题能过，读起来像「过滤器正常，只是市场太薄」，不像 bug。修法：把 Han/Hiragana/Katakana/Hangul 从词字符里排除，使**相邻汉字构成边界**；拉丁侧一毫不改（`IT` 仍不命中 `IThub`）。根模块与 web 镜像同改——CLI 扫描器行为随之变化，这是有意为之：一个规则、一套语义，而用户 `search_queries` 本就在打 `IT项目经理`。不修的话标题门上线当天就会静默毙掉这类目标岗，且发生在 05 的干跑清单**之前**（清单是事后量，误杀当场发生）。

## Considered Options

- **过滤层**：采集落地门 vs 确认入管门（只改默认勾选）vs pipeline.md 写入门。选前者，因为它与城市门/薪资门同构，且复用 CONTEXT.md「薪资下限」已定的「被过滤掉的岗位直接不进结果」模式；确认入管门会让噪声天天出现在结果区，写入门则让结果区与台账继续留噪声。
- **门控语义**：CLI 全语义 vs negative 硬门 + positive 打标 vs 只上 negative。选全语义——两套语义等于把「什么算符合关键词」这个定义裂成两个。
- **城市空值**：回落偏好 vs 维持「空 = 全国」vs 城市强制默认。选回落偏好并另设显式「全国」项；「城市强制默认」等于取消全国搜索能力。
- **代码落层**：全进系统层 vs 全进 `local/` vs 拆开。选拆开——清理脚本带本地假设（郑州、一次性数据操作），留在 `local/` 不增加长期 merge 摩擦。
- **折叠区能力**：只读 vs 可勾选救回 vs 可标「疑似误杀」。
- **词表范围**：本轮不改 vs 只补 negative vs 两侧都调。选不改——positive 改职能词会同时改变 CLI 扫描器行为，改错了两处一起错。

## Consequences

- **收件箱的增长速度结构性下降**：browser 采集的噪声在进结果区之前就被拦下，不再依赖用户在「加入管道」前手工取消勾选。
- **`title_filter.positive` 是域词、不辨职能**：含「软件」「技术」的职位（软件实施工程师、it软件技术支持工程师、软件产品经理）照样通过——这不是关键词不符，是职能错位，标题门治不了。用户已确认由干跑清单把这批单独统计，作为下一轮词表收紧的输入。
- **两条 driver 的行为一致性成为可测性质**：标题门与城市门都是纯函数，`web/tests/lib/browser-search.test.mjs` 与 `web/tests/lib/browser-scan.test.mjs` 可直接断言；两路的接线点各写一次调用。
- **ADR-0007 E4 的注释与代码恢复一致**：猎聘/BOSS 的城市过滤终于真的走在 web 侧。
- **scan-history 的 `skipped_title` 存量会显著增长**：这是有意的——它就是「被过滤岗位」那扇窗的数据源，收件箱变干净不等于发现记录丢失。
- **干跑清单是下一轮的输入而非产物**：候选词表 + 剥尾差异行 + 职能错位样本三份统计都从它出，清理执行完不要丢弃该清单。
- **共享匹配规则多了两处非显然性质**，都写在 `title-keywords.mjs` 的 `WORD_CHAR` 注释里：①词边界不是「Unicode 字母」，汉字被有意排除、反而是边界；②`web/src/lib/core/title-keywords.mjs` 是它的镜像（Turbopack root 锁死在 `web/`，扩展路径 import 不到根模块），由根目录 `tests/title-keywords-parity.test.mjs` 守着。把 `\p{L}` 加回词字符类，或删掉镜像，两处守卫都会变红。
- **被毙岗位的台账送达统一由页面发起。** 服务端 bsk 路径的 rejects 经 `kind:"folded"` 事件送到页面，扩展路径的 rejects 本就是页面侧算的——两者由页面统一 `POST /api/explore/seen {status:"skipped_title"}`，一个写入点，不会「一边写了、一边忘了」。为此 `/api/explore/seen` 有三处配套：①只认闭集里的另一个取值，其余按 `added`；②skip 批次走独立的 `filtered:<scanId>` 幂等命名空间——**不能**复用 `seen:<scanId>`（扩展采集已把同一批 URL 记进那个空间，复用会让整批被判重放而一条不写），也**不能**取名 `seen:…` 的子键（`scan-progress` 按该前缀统计本次采集条数）；③skip 行**跳过内容级去重闸**——它是同一 URL 的另一条事实，不是重复行。
- **扩展路径上一个被毙岗位会在台账留两行**：采集时的 `added`（扩展 content script 在采集期就写了）＋ 门控的 `skipped_title`。这是有意的——两行是两个事实，且台账是 append-only。代价必须记住：**台账行数 ≠ 职位数**，任何按行计数的消费方（统计、whats-new）要先按 URL 归一化去重。
- **词表来源固定在探索页播种的 `ExploreFilters`，门控刻意不回读 `portals.yml`**：只有两路共用同一份词表，同一判定才是可能的。这带出一个必须同改的前置——`explorer-view.tsx` 的 `paramsToBrowser(sp)` 原先没传 base，回落成 `DEFAULT_FILTERS`，于是**从分享链接恢复的浏览器扫描拿着空 positive/negative 进入门控**，门会对着空词表静默放过一切——与本次要修的正是同一类 bug。现已改为 `paramsToBrowser(sp, seed.filters)`。
- **存量清理里的城市门有两种读法，差 4 行**（干跑实测，1871 → 删 1474 / 留 378）。行的 note 里带 ` · 郑州` 的，说明采集时城市条件就是郑州，按郑州重判（决议 8）。但另有 863 行 note 里**没有任何城市证据**——它们出自没带城市的全国搜索，采集时城市门是关的。默认读法（`--city-scope=preference`）把偏好追溯套用上去，等于对这批把「未知城市」当成「错城市」：实测多删 4 行，其中 `IT项目经理` 是用户求职意向里明确要的岗（`search_queries` 就在打它），另 3 行是异地或职能错位。想按采集时的条件重放（不套城市门，交给标题门），用 `--city-scope=replay`。这条留给 `--apply` 之前定。

## Follow-up

- **存量清理的口径已定并执行（2026-09-16）**：`--city-scope=replay` 删 1470，再手工删 2 行（标题带明确异地城市证据的 `信息技术专员【西安】…`、`检测技术负责人【枣庄-薛城区】…`），Processed 段未触碰。理由：差额那 4 行里，`IT项目经理` 与 `信息经理/信息化建设专家`（国机金刚石(河南)）都是 `search_queries` 明确在打的目标岗，仅因 note 里没有城市证据就被追溯偏好判掉；而采集时城市门本就是关的，BOSS 的无城市搜索通常落在账号自身城市。数字、备份与清单路径记在工单 05。
- **决议 10 的回路已落地（同批，gate-visibility 工单 03）**：结果区上方的规则牌从只读升级为可编辑——被毙条目由门自己附带 `gateReason`（命中哪些 negative 条目，或「未命中任何白名单词」）；词表可就地增删；试算用**同一份** `buildTitleFilterExplained` 重判屏上这批结果（会放行 N / 会多毙 M）；保存经 `POST /api/portals/title-filter` 以文本级替换写回 `portals.yml`（注释不丢），**不自动重扫**。折叠区仍只读：放行路径是改词表→重扫，逐条救回依然不做（决议 5 不变）。
- **决议 9（先量后调）仍然成立**：这一批只交付「改得动」这件事本身，没有一个词被自动写进词表——改什么，由用户看着样本自己定。
- **一处本 ADR 未记的后果（评审发现，2026-09-16）：`skipped_title` 会被当成永久去重键。** `scan.mjs` 的 `shouldDedupScanHistoryRow` 对任何非 `added` 状态一律 `return true`，于是被浏览器门毙掉过的 URL 会进入 `collectSeenUrls` 的「见过」集合，**此后不可能再被扫描器加进管道**——哪怕词表已经改对。上面 Consequences 只写了「台账行数 ≠ 职位数」，漏了这条：一次误调的门控会在台账里把那批 URL 变成永久黑名单，且没有任何界面会告诉你。另开票处理（`gate-followups/01`）。
- **系统层改动的锚点裁决：** 根目录 `title-keywords.mjs` 本次被直接修改（CJK 词边界修复 + 新增 `buildTitleFilterExplained`），未按 ADR-0022 决定 2 走 `FORK-LOCAL` 锚点外置。这是决定 11 的明文选择：匹配规则必须一份实现、CLI 与探索页同语义，而 web 镜像既 import 不到根模块、也加载不了 `local/`（Turbopack root 锁死在 web/），把规则切走只会制造第二份语义。记为有意例外——日后 `git merge upstream` 若在此文件冲突，按决定 11 重接，不要改走后者的外移方案。
