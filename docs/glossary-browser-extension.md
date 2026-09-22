# Glossary — 浏览器扩展（BOSS直聘 + 猎聘，就地评估）

协同阅读：`docs/adr/0002-boss-zhipin-extension-inline-evaluation.md`、`docs/adr/0005-liepin-extension-adaptation.md`

## 扩展本体

- **浏览器扩展（browser extension）**：Chrome Manifest V3 扩展，目录 `extension/`，`content_scripts` 双 entry：`*.zhipin.com` 载 `[core.js, site-boss.js]`，`*.liepin.com` 载 `[core.js, site-liepin.js]`。
- **content script**：注入招聘站页面的脚本，负责列表卡片徽章、详情页「评估本职位」+「快评」按钮、已评估/快评徽章，并用 `MutationObserver` 跟随 SPA 动态列表。
- **background service worker**：扩展后台，负责端口探测、content script 与 web 之间的消息转发、发起评估、维护已评估集合、广播徽章刷新。
- **popup（弹窗）**：扩展点图标弹出的面板，展示批量评估进度（解析 web 下发 NDJSON 流）。仅用于批量进度，「评估」本身始终在招聘站页面触发。

## 求职评估通道

- **`/api/batch-evaluate`**：web 端批量评估接口，`POST {urls, cliId, model}`，起真实 CLI 评估，流式返回 NDJSON，自动 reserve→merge→release。插件复用它承载全部评估。可选字段 `jdText`（有则跳过服务端抓取）与 `company`（报告公司字段直接指定）。
- **NDJSON 流**：接口下发的逐事件 JSON 行（`status/text/item/done/error/keepalive`），popup 逐职位渲染进度用。
- **cliId / model**：config 页已存档的评估 CLS 与模型。插件经 web 读取当前配置并回填到评估请求，不重复配置。

## 已评估判定与报告

- **归一 URL（normalizeUrl）**：把职位 URL 降为稳定比较键（strip 跟踪参数等），作为「已评估」匹配 key。`web/src/lib/core/url-key.mjs` 是根 `url-key.mjs` 的镜像，必须 byte 对齐。
- **scoredUrls**：`pipelineSummary()` 内由 reports `**URL:**` header 构建的归一 URL→score 映射，判定「已评估」的现成数据源。
- **报告号（reportNum）**：tracker 应用行的 `n`，也是报告文件/报告页路由编号，跳转 `http://localhost:{port}/report/{num}` 用。
- **已评估映射（evaluated map）**：插件每次加载拉取的 `{归一URL → {score, reportNum}}` 集合；评估完成后主动刷新。

## 站点解耦与内联评估

- **core.js**：content script 的站点无关核心——`normalizeUrl`（接受 site 扩展参数）、徽章/按钮注入、`single-evaluate`/`quick-evaluate` 消息、MutationObserver、boot。
- **site 适配对象（site adapter）**：每站点导出的适配对象契约——`hostMatch`、`cardSelector`、`linkSelector`、`isDetailPath`、`cardIsList`、`cardUrl`、`extractDetailJd`、`extractPosterName`、可选 `extractListPaneJd`/`ensureRightPaneButton`、`extraTrackingParams`。core 按 hostname 分派。
- **site-boss.js / site-liepin.js**：BOSS / 猎聘的适配实现。猎聘无右侧详情面板，故不提供 `extractListPaneJd`/`ensureRightPaneButton`。
- **快评（quick eval）**：秒出分数徽章的轻评估——content script 从 DOM 提取 JD 文本直连 `/api/quick-eval`，只读（不写 tracker/报告/CV）。分数持久化在 `chrome.storage.local` 的 `quickScores`（按归一 URL，含域名），详情页紫徽章显示。
- **内联 JD（jdText）**：content script 从详情页 DOM 提取的 `{title, text}`（快评用）；完整评估（D4）可选携带，后端 `/api/batch-evaluate` 收到即跳过服务端抓取。缺结构化字段时报告标注「未提取」，不编造。
- **poster（发帖方）**：content script 尽力提取的公司名（BOSS 选择器集合；猎聘 `.recruiter-container a[href*="/company/"]` 去"· "前缀）。快评按未知雇主策略（ADR-0004）前缀"发布方公司："；完整评估随 `company` 字段传后端作报告公司。

## 本地服务与安全

- **web 端口探测**：background 对 `localhost:3000-3040` 逐个 `GET /api/version` 找本地 web 服务端口（与 launcher `pickFreePort` 区间一致），命中缓存、失活重探。
- **工具栏连接状态徽章（connection-status badge）**：`background.js` 用 `chrome.action.setBadgeText`/`setBadgeBackgroundColor` 在插件图标上外显本地 web 服务在线状态——绿底 `✓`=已连接、红底 `!`=未连接，全局常显（不带 `tabId`），事件驱动 + 5s 短缓存刷新。决策见 `docs/adr/0050-toolbar-connection-status-badge.md`。
- **origin-guard 放行口**：对 loopback + 固定扩展 ID 的 `chrome-extension://{id}` Origin 放行并回 CORS 头；其余跨站请求仍 403。扩展 ID 由 `manifest.json` 的 `key` 固定。
- **扩展 ID（extension id）**：MV3 由扩展 `key` 派生的稳定标识，后端据此识别可信来源。