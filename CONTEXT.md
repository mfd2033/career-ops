# Career-Ops（求职评估与招聘站扩展）

用户求职自动化的领域模型：职位评估、报告与 tracker 持久化，以及侵入招聘站页面（BOSS直聘、猎聘、智联招聘）的浏览器扩展就地评估。核心职责：给职位打分、把结果写成报告并合并进 tracker、让用户在原站页面上直接看到已评估状态。

## 评估动作

**评估（evaluate）**:
对一个职位运行真实 career-ops 评估（`modes/oferta.md` 的 Blocks A–F + G），产出报告并持久化到 tracker。评估 worker 是 CLI agent，由 `buildPrompt`/`buildBatchPrompt` 驱动。
_Avoid_: 打分（快评才叫打分）、分析

**快评（quick eval）**:
秒出分数徽章的轻量只读评估——content script 从页面 DOM 提取 JD 文本直连 `/api/quick-eval`，单轮 LLM 完成，不写 tracker、不生成报告。分数存 `chrome.storage.local` 的 `quickScores`（按归一 URL，含域名）。
_Avoid_: 快速评估、轻评估

**已评估（evaluated）**:
一个职位已完成完整评估的状态；由 `/api/report-status` 的归一 URL → `{score, reportNum}` 映射判定，扩展据此渲染徽章。
_Avoid_: 已打过分、已评过

## AI 引擎配置

**引擎模式（engine mode）**:
配置页顶部的三选一：`cli`（用本机已装的 CLI 跑评估）、`key`（粘贴密钥，仅快评）、`manual`（无需设置，未实现）。它决定评估走哪条通路，与下面选哪个运行时无关。
_Avoid_: AI 引擎（旧 UI 标题，与「AI 工具」并列会歧义）

**CLI 运行时（CLI runtime）**:
引擎模式为 `cli` 时实际执行评估的外部 AI 命令行工具（Claude Code、Codex、OpenCode 等）。只有本机检测到的运行时可选；未检测到的以「未安装」禁用呈现，仅供知情，不参与选择。
_Avoid_: AI 工具（UI 口语）、引擎（与引擎模式混淆）

**模型（model）**:
某个 CLI 运行时执行评估时选用的模型。留空表示沿用该工具自身的默认。
_Avoid_: 大模型、LLM（口语）

**当前使用（currently using）**:
配置页上「已保存并生效」的运行时与模型，区别于下拉里尚未保存的在途选择。
_Avoid_: 已选、当前选中（口语，未区分「在途」与「已保存」）

**自动检测（auto-detect）**:
配置页对运行时安装情况的自动探测。每台浏览器只在首次成功检查时执行一次，此后永不自动重查——页面渲染缓存的检测结果，更新的唯一途径是手动重检。
_Avoid_: 自动刷新（与手动重检混淆）、定时检测

**检测缓存（detection cache）**:
「这台机器装了哪些运行时」的两层记忆：浏览器侧缓存（检测结果 + 检测时间 + 「已检查过」标记）供配置页免请求渲染；服务端进程内缓存供 jobs/apply 兜底解析等非配置页消费方复用。两层只在手动重检时同时失效。
_Avoid_: 检测结果缓存（太泛）、安装状态（未区分缓存与真值）

**手动重检（manual re-check）**:
配置页上用户主动触发的重新探测：强制服务端缓存失效并真查一次，结果回写浏览器侧缓存并刷新下拉。是缓存过时（如新装了运行时）后的唯一刷新途径。
_Avoid_: 重新扫描、刷新页面（那是绕过而非机制）

## 职位标识

**归一 URL（normalizeUrl）**:
把职位 URL 降为稳定比较键（strip 跟踪/反爬参数）的算法。`web/src/lib/core/url-key.mjs` 是根 `url-key.mjs` 的镜像，**核心参数清单必须逐字节对齐**（parity 测试守卫）；扩展 core 内联副本与 web 镜像同规则。BOSS 专属参数 `securityId`/`ka`，猎聘 `pgRef`/`skId`/`fkId`/`ckId`/`d_*`/`sfrom`，智联 `refcode`/`srccode`/`preactionid`（智联职位详情 URL 本身无参数）。根文件的 FORK-LOCAL 尾部锚点（ADR-0022）注入的 fork-local 扩展参数不参与 parity，web/扩展侧不加载。作用是判定「已评估」与去重的 key，不是展示用 URL。
_Avoid_: 规范化 URL、标准 URL

**原始职位 URL（raw posting URL）**:
数据文件里职位行的原样链接，用于导航：收件箱 triage 行与候选清单的标题据此新标签页打开原始职位网页。原样打开（不做 https 强转、不剥离参数）——归一 URL 只服务身份比较，其变换不外溢到浏览器行为。无法解析为 http(s) 时降级为纯文本，不渲染死链。
_Avoid_: 跳转链接（口语）、规范 URL（与归一 URL 混淆）

**报告号（reportNum）**:
tracker 应用行的 `n`，也是报告文件/报告页路由编号。报告文件 `reports/{NNN}-*.md`，报告页 `/report/{num}`。两个独立来源，互不覆盖：URL 归一 join（`/api/report-status`，问"这个职位被评估成哪份报告"，跟随后续复评换新）与工作器启动时捕获（问"这个工作器引用了哪份报告"，不随后续复评改变，ADR-0018）。
_Avoid_: 报告 ID

**scoredUrls**:
`pipelineSummary()` 内由报告 `**URL:**` header 构建的归一 URL→score 映射，「已评估」判定的数据源。
_Avoid_: 已评列表

## 扩展构件

**site 适配对象（site adapter）**:
每招聘站导出的适配对象契约（`hostMatch`、`cardSelector`、`linkSelector`、`isDetailPath`、`extractDetailJd`、`extractPosterName`、`extraTrackingParams` 等），供站点无关的 core 消费。BOSS 直聘与智联是两栏布局（左列表+右描述面板），额外提供 `extractListPaneJd`/`ensureRightPaneButton`（右栏面板，列表快评入口）；猎聘无右栏，两者均不提供。智联卡片无职位 `<a>`，额外靠 `positionList` 数据源取职位 URL。
_Avoid_: site 插件、适配器

**徽章（badge）**:
注入页面的评分标识。**已评估徽章**：绿色，展示完整评估分数，点击开报告页；**快评徽章**：紫色，展示快评分数，悬停看理由。两者独立存在，互不覆盖。
_Avoid_: 标记、角标

**内联 JD（jdText）**:
content script 从详情页 DOM 提取的 `{title, text}` 文本。快评必带；完整评估可选——`/api/batch-evaluate` 收到即注入评估 prompt，agent 跳过 WebFetch 直接用，缺字段标注「未提取」不编造。
_Avoid_: JD 文本、抓取文本

**发帖方（poster）**:
content script 尽力提取的发帖公司名（BOSS 选择器集合；猎聘 `.recruiter-container a` 去"· "前缀；智联 `DIV.company-info`）。快评按未知雇主策略前缀"发布方公司："；完整评估随 `company` 字段传后端作报告公司。
_Avoid_: 公司名（报告概念才叫 company）

**扩展后台（background）**:
MV3 service worker。职责：探测 web 端口、转发 content script 消息、发起评估、维护已评估集合与快评分、广播徽章刷新。
_Avoid_: 后台脚本

**web 端口探测**:
扩展后台对 `localhost:3000-3040` 逐个 `GET /api/version` 定位本地 web 服务（与 launcher `pickFreePort` 区间一致），命中缓存、失活重探。
_Avoid_: 端口发现、端口扫描

## 探索页扫描

**扫描驱动（scan driver）**:
探索页 browser 模式驱动中国招聘平台采集的方式。现已从 Playwright/CDP（ADR-0001）切换为职位评估扩展 content script（ADR-0007）：content script 跑在用户真实已登录浏览器，`MutationObserver` 捕获页面自身懒加载产生的 DOM 变化即获全量卡片，无需伪造滚轮事件。
_Avoid_: 采集器、浏览器驱动（太泛）

**探索页 tab（explore page tab）**:
跑 `/explore` 的那个本地面板 tab，是扫描收尾的焦点落点。它的存活与"是否停留在 /explore 页面"无关——ExploreProvider 是 shell 级单例，跨软导航不重挂载，所以从侧栏跳去 `/pipeline` 再回来，扫描进度与结果都还在；只有硬刷新或关闭该 tab 才丢，届时仅能靠 per-tab 的 sessionStorage 捞回最近一次**已结算**的结果集。
_Avoid_: 扫描页面（未区分 tab 与页面）、本地面板、host tab

**采集 tab（drive tab）**:
扫描期间扩展新开的招聘站 tab（BOSS/智联各一个，猎聘按关键词拆词可以是多个）。采集由该 tab 自己的 content script 驱动，不依赖探索页存活；收尾不关闭它。
_Avoid_: 招聘站 tab、扫描 tab（与探索页 tab 混淆）

**扫描收尾（scan wrap-up）**:
一次扫描的各平台都采完后，由扩展后台执行的一次性动作：把浏览器焦点切回探索页 tab（配置页开关可关掉这件事）。按 scanId 幂等、也按 scanId 归口——判定"本次采完了没有"只看属于本次 scanId 的登记（猎聘拆词时同一次扫描有多条驱动）；探索页 tab 已不存在时退化为静默跳过。
_Avoid_: 清理、善后、收尾（未限定对象）

**中止采集（aborting a drive）**:
探索页 tab 被用户关闭时，扩展后台向所有仍在采集的采集 tab 发停止指令的动作——接住"用户关页面"这个信号，别再采了。与**扫描收尾**是两件事：收尾是"采完了，把人送回结果页"（受收尾开关管辖），中止是"接结果的那个页面没了，停止浪费"（不受开关管辖）；两者都保留已采数据（照常写 scan-history「见过」台账；ADR-0021 起不再自动写 pipeline.md）。
_Avoid_: 取消扫描、停止收尾（都易与扫描收尾混淆）

**卡片元数据（cardMeta）**:
列表卡片上扩展采集的 `{url, title, company, salary, city?}` 字段。每站 site 适配对象提供 `cardMeta(card)`；智联 city 权威源是 `positionList[].workCity`（window 状态数据）非 DOM，BOSS/猎聘靠 title 兜底。供探索页结果区展示与确认入管（ADR-0021：采集只写「见过」台账，确认才写 pipeline.md）。
_Avoid_: 卡片数据、卡片字段

**幂等扫描（scanId）**:
对单次探索页扫描生成的操作号，路由侧用作幂等键的命名空间（ADR-0021：`seen:<scanId>` 记「见过」、`add:<scanId>` 管确认入管，共用 data/scan-idempotency.tsv 但互不可见，防止确认被 seen 已记录的键整批误杀）。content script 另持本页已采 URL Set 防内部重发——双层幂等。
_Avoid_: 扫描 ID（易与报告号混淆）

**见过台账（seen ledger）**:
`data/scan-history.tsv` 在探索扫描语境下的角色——「这个职位我们什么时候见过」的发现记录（`first_seen`）。ADR-0021 起采集只写它；pipeline.md 的 `- [ ]` 行是显式确认后的另一时刻。它同时是未确认候选的持久层：探索页结果区可从「近期采集、未入管」的行恢复。已知缺口：无薪资列，恢复出的卡片薪资显示「未知」。
_Avoid_: 落库（不区分见过与入管）、扫描历史（口语，易与 scan-runs 运行台账混淆）

**确认入管（confirm to pipeline）**:
把探索页结果区勾选的卡片显式写进 pipeline.md（`- [ ]` 待评行）的动作，粒度为勾选 + 「加入管道 (N)」，默认全选本次新采。扫描从不自动做这件事（ADR-0021）；卡片级「加入管道」与「评估」（语义含入管）同样是显式动作。**批量条的作用域 = 当前筛选后的列表**：计数、全选与确认取自同一集合（`web/src/lib/results-view.mjs`），输入关键词或切 tab 后按钮上的数字恒等于屏幕上可入管的行数——数字若取自整个结果集，一次筛选后的确认就会把没被过目的岗位一并写进 pipeline.md。
_Avoid_: 加入管道（不分自动/显式时易歧义）、落库

**薪资下限（salary floor）**:
browser 模式薪酬条件的唯一输入（探索页），也是收件箱薪资过滤的同一条件——语义两处完全一致：一个「最低月薪（K）」数字，岗位薪资区间与之比较后决定保留或丢弃；留空即不过滤。内部口径一律为月薪（千元/月），与输入一致。被过滤掉的岗位直接不进结果，与城市门控同行为。比较取区间重叠（区间上限 ≥ 下限即保留），沿用 `salary_filter` 的「不误删」取向；薪资未知岗位放行并打标。
代码里的名字：探索页契约字段 `ExploreFilters.zhSalaryMin`、纯函数形参 `salaryMinK`（`browser-search.mjs`）、分享链接参数 `smin`；收件箱侧是 FacetChips 的数字输入（复用探索页 i18n 文案，状态存 localStorage）+「按薪资」排序切换（ADR-0023；默认开，ADR-0024）。同一个概念，改动时勿再另起名。
_Avoid_: 薪资条件（泛）、薪资区间（那是站点的展示区间，不是条件）、salary_filter（那是 CLI ATS 扫描的年薪口径配置，语义无关）

**采集门（discovery gate）**:
探索页 browser 模式在结果集生成前套用的三道确定性过滤——城市门、薪资门、标题门，都实现为 `browser-search.mjs` 的纯函数，由 bsk 服务端与扩展页侧两条 driver 共用。三道的共同语义是「被过滤掉的岗位直接不进结果」；共同取向是「条件缺省或数据缺失即放行，不误删」。
_Avoid_: 过滤器（太泛）、前置过滤（与评估期的 pre-screen 混淆）

**检索词（zhQuery）**:
探索页 browser 模式发给招聘站的搜索词（页面上的关键词框）。它写作搜索 URL 的 `{q}`，空格会展开成 `OR`；猎聘不认多词，故按词拆成多条搜索。**它只决定站点返回什么，不参与落地判定**——它不是一道门。播种来源是 `config/profile.yml` 的 `target_roles`（primary + archetypes.name），缺失才退回 `portals.yml` 的 `search_queries`。
_Avoid_: 关键词（与 `title_filter` 的 positive 混用——这次混淆的直接来源）、查询条件

**标题门（title gate）**:
采集门的第三道，判据是 `portals.yml` 的 `title_filter`——与 CLI 扫描器同一份词表、同一套语义（positive 命中 ≥1 且 negative 0 命中）。匹配面是站点给的原始 title 不剥尾，误杀靠调词表重扫纠正；被毙掉的岗位照常写一行 `scan-history.tsv`（status=`skipped_title`），并在结果区以只读的**已过滤区**展示。见 ADR-0029。
**与检索词没有任何自动耦合**：检索词命中的岗位照样可能被毙（positive 里没有对应词），不命中检索词的岗位照样可能被放行（命中别的域词）——两边一起调才能同时管住「站点找什么」与「留下什么」。
_Avoid_: 关键词门（易与**检索词** zhQuery 混用）、职业门

**城市门（city gate）**:
采集门的第一道，优先取职位的结构化城市字段（智联 `positionList[].workCity`），缺失才回退 title 里出现的已知城市名（`BROWSER_CITY_MAP`）。城市条件留空时**回落 `location_filter.allow`**——本次条件覆盖长期偏好、不设则用偏好；真·全国要用城市下拉里显式的「全国」项表达，不能靠留空。
_Avoid_: 地点筛选、地区过滤

**已过滤区（filtered bin）**:
探索页结果区里承载被采集门毙掉岗位的只读折叠区（「已过滤 (N)」），展示用、不可就地救回——要放行须先改词表再重扫，这样 `scan-history` 里的 `skipped_title` 与收件箱事实永远一致。
_Avoid_: 黑名单（那是 `data/blacklist.md`，公司级、语义无关）、被拒列表

**薪资文本（salaryText）**:
从列表卡片提取的原始薪资展示字符串（如「20-35K·14薪」），由扩展 `cardMeta` 与 bsk 采集携带、随 DiscoveredOffer 透传落库展示。过滤用的数值区间由它解析得出，解析出的数值不单独落库。站点口径差异：猎聘的裸「万」（如「20-35万」）是**年薪**口径（÷12 折算月薪），智联的「万」（如「1.5-2.5万」）是**月薪**口径（×10 折算 K），智联另有「7000-8000元」的元/月形态（÷1000）；「·N薪」为年度系数，比较时忽略。BOSS 的薪资**数字**在 DOM 里是 PUA 私用区码点（字体反爬），采集侧按实证映射 `\uE031+n = 数字 n` 解码，即 E031=0 … E03A=9（E031=0 一段由 2026-09-14 人工对照确认；E03A=9 由同日四个搜索列表页取证 + 详情页明文反查确认，此前它落在映射范围外，含 9 的薪资一律被丢成「薪资未知」）；仍是零观测码点（E030）的薪资整体归「薪资未知」，不做部分解码。注意该混淆只出现在**搜索列表卡片**上，职位详情页的薪资是明文。
_Avoid_: 薪资（数值含义不明）

**薪资未知（unknown salary）**:
采集卡片无薪资文本、或薪资文本解析不出数值的岗位状态。放行进入结果（沿用 salary_filter「无薪资数据不误删」的取向），展示时打标提示，与已确认达标的岗位可区分。
_Avoid_: 面议（站点展示术语）、无薪资（模糊）

**收件箱薪资（inbox salary）**:
收件箱行显示、过滤与排序所用的薪资，事实源是 pipeline.md 行 note 的尾段——确认入管时写入的 salaryText 原文（或解析不出时的「薪资未知」标记）。仅认「 · 」分隔的末段严格匹配该形态，用户手写的 note 内容永不被解析为薪资；解析不出即按「薪资未知」处理（放行、打标、排序沉底）。展示原文直出不做换算，过滤复用「薪资下限」，排序按解析区间中位值降序、平手与未知回退新鲜度。「按薪资」排序与「未评分」过滤在收件箱默认激活（持久化于 localStorage，无记录时用默认开，ADR-0024）。不加专用薪资列的理由与未来迁移路径见 ADR-0023。
_Avoid_: compensation（pipeline.md 的位置列，与薪资无关）、报告薪资（tracker 行来自评估报告的口径，非采集卡片）

## 雇主策略

**未知雇主（unknown employer）**:
发帖未点名终端雇主的职位（代招/中介岗）。两种处理策略：`placeholder`（显示 `?`）或 `agency`（显示代招公司名）。全局配置，影响报告/快评/tracker 显示。
_Avoid_: 匿名雇主、隐藏雇主

**"?" 占位符**:
未知雇主默认的 company 值（locale 无关标记，绝不用 "Confidential"）。
_Avoid_: 问号、保密

**代招（agency posting）**:
通过招聘/人力中介发布的职位，终端雇主未命名。策略为 `agency` 时用发帖中介名作 company。
_Avoid_: 中介岗（口语，写文档用「代招」）

## 报告浏览

**列表上下文（list context）**:
用户在管道列表上的当前视图口径：看哪个阶段（tab）、按什么排序、搜什么词。报告页的上一份/下一份相对这个口径成立——同一份报告在不同口径下相邻的报告可以不同；它随导航被带进报告页，保证「下一个」与用户刚看的那个列表一致。
_Avoid_: 筛选条件、过滤状态

**报告导航（report navigation）**:
报告详情页在相邻报告之间的移动（上一份/下一份）。相邻关系由列表上下文决定；没有列表上下文的入口（扩展深链打开的单份视图）没有相邻报告，也没有这组导航。
_Avoid_: 报告分页、上一页/下一页

**跳过（skip）**:
报告页上的动作：把这个岗位标记为「已放弃」，接着看下一份报告；没有下一份时回到列表。它不是 tracker 的终态之一——那个终态的含义是"岗位不适合、不投递"，中文显示恰好也叫「跳过」；两者一个是动作、一个是状态，不可互推。
_Avoid_: 略过、忽略

## 评估性能

**评估墙钟（eval wall-clock）**:
一次完整评估从贴 JD/URL 到产出报告+PDF+tracker 的实测总时长。主成分是 LLM turn 数 × 每 turn 延迟（引擎不变则每 turn 延迟固定），PDF 定制是独立的二次 LLM 大活。优化手段只减 turn 不减内容（ADR-0009）。
_Avoid_: 评估速度、评估耗时（口语）、评估用时（现为独立词条，指列表展示口径）

**耗时埋点（eval timing）**:
每次评估用 `log-eval-timing.mjs` 按固定步骤集（extract/liveness/eval/report/pdf/answers/tracker）记录墙钟耗时到 `data/eval-timings.tsv`，供前后对比。三条评估路径（web 单条、web 批量、CLI 交互式）均打点（ADR-0017）；pdf 步在 CLI 由 agent 打、在 web 由平台后端打（pdf 类工作器无 Bash，#2172）。属用户层数据。
_Avoid_: 计时、性能日志

**评估会话（eval session）**:
同一报告号在耗时埋点 TSV 中由 `extract` 行开启的一组连续步骤行；复评开启新会话（`liveness` 总是跟随 extract，不开启会话）。无起点的残缺行（旧数据/中断）自成一节；孤立的 pdf/answers 行（PDF 延后补跑且无原会话可归）不构成会话。
_Avoid_: 评估轮次、计时会话

**残缺会话（partial session）**:
没有 `extract` 起点行的评估会话——web 单条评估的常态：agent 打分在前、经 reserve 拿到报告号在后，故只打 report/tracker 行（ADR-0017）。解析器按既有行照常求和，不是缺陷。
_Avoid_: 不完整数据、缺步 bug

**评估用时（eval duration）**:
某报告号最近一次评估会话中、至报告交付（extract/liveness/eval/report 步）为止的各步墙钟之和，是 `/jobs` 工作器卡片与 `/pipeline` 用时列的展示口径。不含延后补跑的 pdf/answers/tracker 步——它们属后续动作，但在 `/pipeline/{n}` 分步明细中可见。与评估墙钟的区别：墙钟是性能优化语境的全过程实测（ADR-0009），评估用时是面向展示的口径化指标。它是**评估**的指标，只归评估类工作器（evaluate/batch-evaluate）；工作器解析出报告号不等于展示该报告的用时——pdf 工作器显示自身墙钟（ADR-0018）。
_Avoid_: 评估耗时（口语）、总用时（未定义口径）

**PDF 延后（PDF on demand）**:
一次完整评估默认不自动生成 PDF/申请答案，先交付报告，用户确认后才生成（覆盖 auto-pipeline 自动默认）。低分岗不推荐投递，自动 PDF 常属浪费。
_Avoid_: PDF 延迟、PDF 选项

## 并发执行

**工作器(worker)**:
web 端一次可观测的后台任务，一条记录对应一次 CLI 子进程运行（或一次排队等待），在 `/jobs` 历史、侧栏工作器卡片与 `/jobs/{id}` 详情页呈现。种类（kind）有 evaluate / pdf / batch-evaluate / research / fix-portal，各自解释 `input` 的含义（职位 URL、报告号、公司名、target 或多行 URL），并可选携带它引用的报告号（ADR-0018）。
_Avoid_: 任务、作业、进程（口语）；流水线（那是 `/pipeline` 的旧称，曾因此把工作器详情页误当成流水线页面）

**全局并发池(global concurrency pool)**:
web 端调度所有 CLI 工作器子进程的 module-level 调度器，用一个并发数字限制同时运行的上限(默认 4，config 页可调)。覆盖全部入口——web 单卡、web 批量、BOSS 扩展——统一共享同一池。粒度按 CLI 子进程计，不按批次(ADR-0014)。
_Avoid_: 线程池、进程池(易与 OS 概念混淆)

**执行槽(execution slot)**:
全局并发池的并发单位，一个 CLI 子进程占一槽。取到槽才允许 spawn，未取到则入队等待。
_Avoid_: 名额、额度(口语)

**执行中(running)**:
任务已取得执行槽、CLI 已 spawn 的态。与「排队中」对立，类似 active-runs 原 in-flight 语义；写令牌(tracker 互斥)只在此时持有。
_Avoid_: 在飞(旧词，歧义，见排队中)

**排队中(queued)**:
任务已接受但未取到执行槽、未 spawn CLI 的态。不占写令牌；可被用户取消(dequeue)。对应 `/api/active-runs` 的 `queued` 聚合。
_Avoid_: 在飞、等待中(口语)

## Fork 维护

**锚点（fork-local anchor）**:
系统层文件里唯二的 fork 专属代码：一个 `await import('./local/…')` 加载点加一行调用（或尾部导出+参数注入），带 `FORK-LOCAL anchor (ADR-0022)` 注释。职责是把 gitignored `local/` 层的逻辑接进系统文件；`local/` 缺失时降级为上游原行为并打 warn。锚点行位置刻意选在上游不常改动的区域，使 git merge 三方合并自动通过。
_Avoid_: 补丁（patch，暗示会被重放）、hook（它不是上游提供的扩展点，是我们自己打的孔）

**fork-local 层（local layer）**:
gitignored 的 `local/` 目录，存放只属于本 fork 的代码扩展（扫描去重扩展、去重参数清单），`.gitignore` 与 `config/local-paths.txt` 双重豁免。加新站去重参数只改这里；上游 merge 永远不会碰它。决策与取舍见 ADR-0022。
_Avoid_: 本地补丁、私有目录（未表达「被锚点引用、有降级契约」的结构关系）

**tripwire 测试（tripwire test）**:
gitignored 的 `tests/local-*.test.mjs`，锚点或 local/ 层失效（换机器 clone 漏拷、上游重构切断锚点）时变红的哨兵。test-all.mjs 按目录扫描发现（不看 git 状态），照常自动运行。
_Avoid_: 回归测试（太泛——它是哨兵语义，专测「fork 层还活着吗」）

## 公司尽调

**公司体检（company checkup）**:
oferta 评估完成之后、对入围公司运行的入职前尽调（本机 offer体检 技能驱动）：7 维调研（待遇/参保人数/劳动仲裁/招聘套路/网络口碑/抖音口碑/高德口碑）+ 工商交叉校验，产出单文件 HTML 报告与体检星级。它是**后置独立步骤**，不是评估的一部分——不改 A-G 结构、不计入评估的调研预算、不触达 1-5 分（ADR-0025）。主动建议只对中国大陆公司触发（score ≥ 4.0 或 Block G 有 ⚠️ 信号），用户确认才执行；显式点名任何时候可跑（海外公司也行，技能自行标注未获取到）。
_Avoid_: Block G 信号（那是评估内的合法性判断）、背景调查（那是入职后流程）、公司研究（那是 Block D 的有预算上限的调研动作）

**体检星级（checkup star）**:
公司体检产出的 1–5 星雇主可靠性分（0.5 步进，5.0 基准扣分制：参保/规模/主体/仲裁/口碑/套路）。它回答「这家公司作为雇主靠不靠谱」，与评估的 1-5 分（岗位匹配度）语义无关，两者永不互相折算或修改（ADR-0025）。≤2.0 星附「面试必须确认的红线」清单，仅作文本附注。
_Avoid_: 推荐分、评分（口语——与评估 score 混淆）、公司分

**公司体检台账（checkup ledger）**:
`data/company-checkups.tsv` 在本语境的角色——append-only 的体检结果记录，由 `lib/log-checkup.mjs` 守护写入（校验星级枚举/日期/拒绝覆盖），是体检数据的**唯一机器消费通道**（dashboard 星级徽章、analyze-patterns 体检维度都读它；ADR-0025）。关联键是 tracker#：评估后触发的直接挂；公司名模式先经 invite-match 匹配，未命中允许 `?` 空键（company-slug 仍可关联，日后人工补挂）。评估报告的 Machine Summary 不加键——schema 单一来源原则。
_Avoid_: 体检日志、checkup 历史（口语）、体检数据库

**体检报告（checkup report）**:
公司体检的单文件 HTML 产出，存 `reports/checkups/{tracker#}-{company-slug}-{YYYY-MM-DD}.html`（技能自带 reports/ 目录弃用）。完成后在对应评估报告尾部追加人读附录（星级 + 链接 + 主要风险）。人读为主，机器数据走台账。
_Avoid_: 评估报告（那是 `reports/{###}-*.md`，两回事）

**体检请求（checkup request）**:
行详情页「体检这家」按钮触发的执行请求（ADR-0027）：按下即用户确认，经 **worker kind=checkup 即时执行**（全局并发池 + 引擎模式 CLI runtime，/jobs 实时进度），prompt 为指针式——tracker#、公司名与「按 modes/_custom.md 公司体检规则执行」，编排规则单一来源在 `_custom.md`。`?` 行的体检对象是招聘主体（report Via）。同 tracker# 当天已派发或 pending 的请求被 409 去重；agent-inbox 同步写一条已标记行（含 job id）作审计轨迹，drain 时跳过。历史遗留的 pending 请求仍走会话 drain 执行（两条路并存，ADR-0027 决议 5）。
_Avoid_: 体检任务（worker 的正式称谓是 kind=checkup）、体检队列（旧异步通路的遗留语）

