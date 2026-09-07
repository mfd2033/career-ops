# ADR-0005：浏览器扩展适配猎聘（liepin.com）——站点解耦与内联评估

- 状态：提议（Proposed）
- 日期：2026-09-07
- 相关：ADR-0002（BOSS 直聘扩展）、ADR-0001（浏览器全量采集）、`/api/batch-evaluate`、`extension/*`、`web/src/lib/core/url-key.mjs`

## 背景

用户在猎聘上的招聘活动已到第二主战场。BOSS 扩展（ADR-0002）只有 `*.zhipin.com` 的 content_scripts matches，且列表卡片选择器、JD 提取、按钮注入逻辑全部硬编码在 `extension/content.js` 单文件里——站点一旦增多，单文件 hostname 分支必然恶化。

### 猎聘 DOM 调研事实（bsk 实测，2026-09-07）

- **搜索页**：`https://www.liepin.com/zhaopin/?key={词}`，SPA 渲染，落地 URL 不变。卡片容器 `.job-card-pc-container`（外层带每次加载随机变化的哈希 class，不可依赖），职位链接稳定锚点 `a[data-nick="job-detail-job-info"]`。**无右侧详情面板**（`.content-right-section` 为空广告位）——卡片点击 `target="_blank"` 开新标签跳详情页。
- **详情页**：`/job/{id}.shtml`，推荐位变体 `/a/{id}.shtml`。**游客可读全量**（SSR 直出，标题/薪资/描述/公司/招聘者全可见）。**无 `<h1>`**；标题 `.job-apply-container .name-box > span.name`、薪资 `span.salary`、职位描述 `section.job-intro-container > dl.paragraph > dd[data-selector="job-intro-content"]`、公司名 `.recruiter-container a[href*="/company/"]`（文本带"· "前缀）。
- **登录态**：搜索页需登录态（未登录只渲染推荐页）；详情页不需。
- **URL 反爬参数**：卡片链接携带 `pgRef`/`d_sfrom`/`d_ckId`/`d_curPage`/`d_pageSize`/`d_headId`/`d_posi`/`skId`/`fkId`/`ckId`/`sfrom`/`curPage`/`pageSize`/`index` 等——每次请求变化，去重键须 strip 后仅留 `https://www.liepin.com/job/{id}.shtml`。`skId`/`fkId`/`ckId` 等价 BOSS 的 `securityId`。
- **反爬清空**：lp-security 脚本加载后 2-4s 清空页面到 `about:blank`，升级后跳 `safe.liepin.com` 验证码墙——只影响**自动化通道**（bsk/Playwright）；用户正常浏览无此问题，扩展注入不受影响。

### 既有资产（非新建）

| 资产 | 位置 | 作用 |
|------|------|------|
| BOSS 扩展 | `extension/`（manifest + content.js + background.js + popup） | 按钮注入、徽章、快评消息、MutationObserver、diag 全部可复用 |
| `/api/quick-eval` | `web/src/app/api/quick-eval/route.ts` | 快评：DOM 已提取 JD 文本，直连 LLM，免服务端抓取 |
| `/api/batch-evaluate` | `web/src/app/api/batch-evaluate/route.ts` | 完整评估：POST `{urls, cliId, model}`，起 CLI、NDJSON 流、报告号分配 |
| `normalizeUrl` | `web/src/lib/core/url-key.mjs`（镜像根 `url-key.mjs`，byte 对齐约束） | 职位 URL 归一 key，作已评估匹配键（`/api/report-status`） |

### 约束

- **完整评估目前只发 URL**，后端无登录态裸抓猎聘不可靠（Chinese Board 名单，AGENTS.md 明确 WebFetch/Playwright 全被拦）。
- **快评已走 DOM 内联**（`quick-evaluate` 消息带 `{title, text, poster}`），天然绕过登录墙——内联路径是已验证可行通道。
- 猎聘**搜索页卡片无职位描述全文**（只有标题/薪资/公司），列表卡片快评不可行——快评入口只能详情页。

## 决策

### D1：共享核心 + 每站点适配文件

`extension/content.js` 拆为三文件：

- `extension/core.js`：站点无关逻辑——`normalizeUrl`（接受 site 扩展参数）、徽章/按钮注入、`single-evaluate`/`quick-evaluate` 消息、MutationObserver、`applyAllInjections`、boot、diag。
- `extension/site-boss.js`：BOSS 适配对象——原 `content.js` 的选择器（`li.job-card-box`、`a[href*="/job_detail/"]`）、`extractDetailJd`、`extractPosterName`、`extractListPaneJd`、`ensureRightPaneButton`、`extraTrackingParams`（securityId/ka 已含）。
- `extension/site-liepin.js`：猎聘适配对象（见 D3）。

site 适配对象契约（core 消费）：

```js
{
  hostMatch: /liepin\.com$/i,          // core 据此判定当前站
  cardSelector: "[class*='job-card-pc-container']",
  linkSelector: 'a[data-nick="job-detail-job-info"]',
  isDetailPath(pathname),              // 猎聘：/job/ 或 /a/ 前缀
  cardIsList(card), cardUrl(card),
  extractDetailJd(),                    // → {title, text}
  extractPosterName(),                  // → 公司名（去"· "前缀）或 ""
  extractListPaneJd?,                   // BOSS 有；猎聘不提供（无右栏）
  ensureRightPaneButton?,               // BOSS 有；猎聘不提供
  extraTrackingParams: [/^pgRef$/i, ...],
}
```

### D2：manifest 双 content_scripts entry

```json
"content_scripts": [
  { "matches": ["https://*.zhipin.com/*"], "js": ["core.js", "site-boss.js"] },
  { "matches": ["https://*.liepin.com/*"], "js": ["core.js", "site-liepin.js"] }
]
```

每页只加载本站所需的 site 文件。扩展 `key` 字段不变，ID 稳定，后端 origin-guard 放行不受影响。后续加站（zhaopin）只加 entry + site 文件。

### D3：猎聘功能范围

对齐 BOSS 语义，但减去列表右栏（猎聘无此面板）：

- 详情页（`/job/{id}.shtml`、`/a/{id}.shtml`）：「评估本职位」+「快评」两按钮、已评估徽章、快评徽章。
- 搜索页（`/zhaopin/`）：列表卡片**已评估徽章**（evaluated map 命中时）。无按钮、无快评（卡片无描述全文，提取不足）。
- 快评提取（site-liepin）：标题 `.name-box > span.name`（无 h1）、薪资 `span.salary`、描述 `dd[data-selector="job-intro-content"]`（含岗位职责+任职要求全文）；组合 `{title, text}`。
- 发帖方提取：`.recruiter-container a[href*="/company/"]` 文本去"· "前缀。

### D4：完整评估内联文本（jdText）

- `single-evaluate` 消息加可选 `{ jdText, company }`；background 透传 `/api/batch-evaluate`。
- `/api/batch-evaluate` 加可选字段：`jdText`、`company`（见 D5）。抓取不发生在独立服务端步骤——评估 worker 是 CLI agent，prompt 第 1 步指示它 `WebFetch` 读职位（`buildPrompt`/`buildBatchPrompt`）。实现：`buildBatchPrompt` 接收 `jdText`，注入评估 prompt 并改写第 1 步为「用提供的 JD 文本，不要 WebFetch」；`company` 注入公司名指令（报告 header / TSV / 文件名 slug）。BOSS 不传时 prompt 与现状逐字节一致，零行为变化。
- 内联 JD 缺福利等结构化字段时，报告对应字段标注「未提取」，照常生成。

### D5：报告 company 字段来源

`/api/batch-evaluate` 加可选 `company`：扩展把 `extractPosterName()` 结果随 jdText 一起传，后端直接用（DOM 精确提取优于 LLM 猜测）。无 poster 时回退现有逻辑 / `?` 兜底（未知雇主策略，ADR-0004 沿用）。

### D6：按钮/徽章定位

- 详情页：复用 BOSS fixed 右上定位（徽章 top:80 right:20，两按钮在其下堆叠，`updateButtonPosition` 共用）。
- 搜索页卡片徽章：复用右上 absolute 定位，实现时实测微调 top 避让猎聘「急聘」标/薪资行。

### D7：URL 归一化参数扩展

- core `normalizeUrl` 的 `TRACKING_PARAMS` 为全局集 + site `extraTrackingParams` 合并。
- 猎聘清单：`pgRef`、`d_sfrom`、`d_ckId`、`d_curPage`、`d_pageSize`、`d_headId`、`d_posi`、`skId`、`fkId`、`ckId`、`sfrom`、`curPage`、`pageSize`、`index`。
- **后端同步**：`web/src/lib/core/url-key.mjs` 及根 `url-key.mjs` 的 `TRACKING_PARAMS` 加同一清单——否则 `/api/report-status` 的 key 与扩展端不一致，已评估判定漂移。byte 对齐约束保持。

### D8：广播范围扩展

background 的 `quick-updated` / `evaluated-updated` 广播对象从 `*.zhipin.com` 扩到 `*.zhipin.com` + `*.liepin.com`（快评完成后刷新所有相关 tab 的徽章）。

### D9：范围边界

本轮只做猎聘单站。架构（D1/D2）留好扩展点，zhaopin 等以后按需加。

## 理由

- **共享核心**：徽章/按钮/消息/observer 与站点无关，拆出后 BOSS 逻辑零复制；site 文件只含选择器+提取，站点改版只动一个文件。
- **双 entry**：每页只载所需脚本，site 间零串扰。
- **内联 jdText**：绕开猎聘登录墙/反爬，快评已验证 DOM 内联通道可行；后端有 jdText 优先、无则抓，天然兼容（调研显示猎聘详情页游客可读，裸抓可能本就能通）。
- **company 用 DOM 提取**：公司名错则 tracker 全链错，DOM 精确值优于 LLM 猜测。
- **normalizeUrl 参数化**：与后端 url-key 同步后，猎聘已评估判定与探索页/管道页共享同一去重语义。

## 取舍 / 风险

- **content.js 重构回归**：拆 core+site-boss 有 BOSS 行为变化风险 → 分步验证（见测试），每步确认零回归。
- **猎聘搜索页需登录态**：未登录看不到卡片 → 徽章不出现。与 zh-collect 已知行为一致，非缺陷。
- **选择器脆弱性**：`.job-card-pc-container` 外层哈希 class 不可依赖，已用稳定锚点（data-nick 属性、data-selector 属性）。猎聘改版仍可能断，靠 MutationObserver + diag 兜底排查。
- **`/a/{id}.shtml` 变体**：`isDetailPath` 覆盖 `/job/` 与 `/a/`；后端 `lib/zh-jobs.mjs` 的 `isZhJobDetailUrl` 正则 `/liepin\.com\/job\/\d+/i` 不匹配 `/a/` 路径——本期只修扩展侧，采集侧正则修复列为后续。
- **内联 JD 字段不全**：福利/属性等结构化字段缺失，报告标注「未提取」，不编造（数据契约）。
- **快评分数跨站共用**：`chrome.storage.local` 的 `quickScores` 按归一 URL 存（含域名），猎聘/BOSS 互不污染。

## 测试

分步验证（用户配合，登录态浏览器 + 未打包扩展）：

1. **拆结构回归**：只提交 core+site-boss 重构，加载扩展走 BOSS 列表页+详情页，徽章/按钮/快评行为与重构前一致。
2. **猎聘功能**：加载扩展 → 猎聘搜索页（已登录，卡片出现已评估徽章）→ 点卡片新标签 → 详情页两按钮+徽章 → 快评出分（紫徽章）→ 评估出报告（绿徽章）。
3. **后端 jdText**：curl `/api/batch-evaluate` 带 `jdText`+`company`，验证跳过抓取、报告生成、缺字段标注「未提取」。

自动化：

- unit：site 选择器函数、`normalizeUrl` 猎聘参数 strip、`isDetailPath`（`/job/` 与 `/a/`）、site 对象契约形状。
- 回归：`url-key` parity 测试不破；web tsc + 既有测试全绿。
- 手工清单：BOSS 全功能回归表（列表徽章、详情两按钮、快评、错误框、广播刷新）。

## Out of scope

- zhaopin（智联）适配——架构留扩展点，本期不做。
- 猎聘列表卡片快评——卡片无描述全文，提取不足。
- 猎聘批量评估（列表多选）——BOSS 侧勾选框本就 dormant，猎聘不复刻。
- 后端采集侧 `zh-jobs.mjs` 的 `/a/` 路径正则修复——采集独立链路，后续处理。
- 移动端 / 非 Chromium 浏览器。
