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

## 职位标识

**归一 URL（normalizeUrl）**:
把职位 URL 降为稳定比较键（strip 跟踪/反爬参数）的算法。`web/src/lib/core/url-key.mjs` 是根 `url-key.mjs` 的镜像，必须逐字节对齐（parity 测试守卫）；扩展 core 内联副本与 web 镜像同规则。BOSS 专属参数 `securityId`/`ka`，猎聘 `pgRef`/`skId`/`fkId`/`ckId`/`d_*`/`sfrom`，智联 `refcode`/`srccode`/`preactionid`（智联职位详情 URL 本身无参数）。作用是判定「已评估」与去重的 key，不是展示用 URL。
_Avoid_: 规范化 URL、标准 URL

**报告号（reportNum）**:
tracker 应用行的 `n`，也是报告文件/报告页路由编号。报告文件 `reports/{NNN}-*.md`，报告页 `/report/{num}`。
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
