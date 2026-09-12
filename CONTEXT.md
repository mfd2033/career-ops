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
把职位 URL 降为稳定比较键（strip 跟踪/反爬参数）的算法。`web/src/lib/core/url-key.mjs` 是根 `url-key.mjs` 的镜像，必须逐字节对齐（parity 测试守卫）；扩展 core 内联副本与 web 镜像同规则。BOSS 专属参数 `securityId`/`ka`，猎聘 `pgRef`/`skId`/`fkId`/`ckId`/`d_*`/`sfrom`，智联 `refcode`/`srccode`/`preactionid`（智联职位详情 URL 本身无参数）。作用是判定「已评估」与去重的 key，不是展示用 URL。
_Avoid_: 规范化 URL、标准 URL

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

**卡片元数据（cardMeta）**:
列表卡片上扩展采集的 `{url, title, company, salary, city?}` 字段。每站 site 适配对象提供 `cardMeta(card)`；智联 city 权威源是 `positionList[].workCity`（window 状态数据）非 DOM，BOSS/猎聘靠 title 兜底。供 `/api/explore/add` 落库与探索页扫描。
_Avoid_: 卡片数据、卡片字段

**幂等扫描（scanId）**:
对单次探索页扫描生成的操作号，路由侧用作幂等键，防前端连点重复写 pipeline/scan-history（`addOffersToPipeline` 不去重）。content script 另持本页已采 URL Set 防内部重发——双层幂等。
_Avoid_: 扫描 ID（易与报告号混淆）

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
