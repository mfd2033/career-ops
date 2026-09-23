# ADR-0006：浏览器扩展适配智联招聘（zhaopin.com）——第三站，右栏面板与 state 数据源

- 状态：已接受（Accepted）
- 日期：2026-09-07
- 相关：ADR-0005（猎聘扩展）、ADR-0002（BOSS 扩展）、`extension/core.js`、`extension/site-boss.js`、`extension/site-liepin.js`、`lib/zh-jobs.mjs`、`lib/url-key.mjs`（web 镜像 `web/src/lib/core/url-key.mjs`）
- 后续：本篇沿用 ADR-0005 D4 的内联 JD 通道（右栏「评估本职位」也带 `jdText`）。该通道的**传输部分已被 [ADR-0051](0051-extension-single-eval-via-run.md) 部分取代**：三站（含智联右栏）的单职位评估改走 `/api/run`，提取文本与雇主名的语义不变。

## 背景

猎聘（ADR-0005）落地并验证了「共享 core + 每站 site 文件」的架构，其 Out of scope 明说 zhaopin 留扩展点后续按需加。用户第三主战场是智联招聘。本轮把扩展扩展点用到智联。

### 智联 DOM 调研事实（bsk 登录态浏览器实测，2026-09-07）

**搜索页**真身 = `www.zhaopin.com/jobs?jl={城市码}&kw={词}`（`sou.zhaopin.com` 301 重定向而来）。

- **两栏布局**：外层 `DIV.jobs-split-page`，右栏 `DIV.job-detail-panel` **含当前选中职位描述全文**（`.job-description`，实测 577 字符），小节标题 `SPAN`=「职位描述」。→ **可用 BOSS 式右栏按钮 + 列表快评**，与猎聘「仅徽章」不同。
- **卡片** = `DIV.job-card`，**零 `<a>` 包裹**；卡片内唯一 `<a href>` 指向**公司详情**（`companydetail/…`），非职位详情。→ **职位 URL 无法从卡片 DOM 取得**，必须用 `window.__INITIAL_STATE__.positionList[].positionUrl` 合成。
- `positionList`：数组长 20，对象键极多，关键：`positionUrl` 与 `positionURL`（大小写两个**同名同值并存**）、`positionUrl` = **完整绝对 URL**（`http://www.zhaopin.com/jobdetail/{number}.htm`，无需补 host）、`number`（=`companyNumber + J + jobId`）、`jobId`、`name`、`workCity`、`salary60`、`companyName`、`companyUrl`、`jobDescription`（**卡片项自身带描述正文**）。`positionCount` 恒为 `0`（**不可信**）。
- **active 卡** = `DIV.job-card--active`（另有 `--viewed`）。点击卡片：`.job-card--active` 移到该卡，右栏 `.job-detail-panel` 同步重渲染。**坑**：`__INITIAL_STATE__.selectedJobId` 是冻结快照、点击后**不随动**——真 active 活在 Vue 响应式状态里，**读当前职位须以 `.job-card--active`+右栏内容为准，不信 `selectedJobId`**。positionList 数组顺序与 DOM 卡片顺序一致，可用 active 卡 index 或标题匹配映射到 positionUrl。
- **结果页 URL 干净**：仅 `jl`+`kw` 两查询参数，无易变跟踪参数。但页内跳转锚点带 `refcode`、`srccode`、`preactionid`（`preactionid` 每次操作即变 uuid）→ 进 `extraTrackingParams`。

**详情页**真身 = `www.zhaopin.com/jobdetail/{number}.htm`（host=www，非 jobs 子域、非 zpdetail；positionUrl 给 `http://`，实打开升级 https）。URL **无查询参数**。登录用户游客级完整可读，无验证墙。

- 标题 `h1`；薪资 `SPAN.summary-planes__salary`（实测 `8000-13000元·13薪`）；职位描述正文 `DIV.describtion-card.seo-card.seo-card--default`（站点拼写 typo "describtion-card"，照用）；公司名 `DIV.company-info`（发帖方=公司名）。城市无独立稳定 class，可靠来源是 `positionList[].workCity`；勿用 header 的 `.city`（那是站点城市非职位城市）。

## 决策

### D1：第三站 site 文件，manifest 加 entry

- 新增 `extension/site-zhaopin.js`，导出的 `ZHAOPIN_SITE` 适配对象交给 core 启动（对齐 `site-boss.js`/`site-liepin.js` 的 node 测试桥模式）。
- manifest content_scripts 加一条 `matches: ["https://*.zhaopin.com/*"], js: ["core.js", "site-zhaopin.js"]`。单 entry 通配子域（www + sou + jobs 全盖），不拆多 entry。`key` 字段不变，扩展 ID 稳定，后端 origin-guard 不受影响。

### D2：功能范围 = BOSS 式右栏

智联搜索页是两栏（左列表+右描述面板），与 BOSS 同构，与猎聘（无右栏）不同。功能对齐 BOSS：

- **搜索页右栏**（`.job-detail-panel`）：`ensureRightPaneButton` 双按钮「评估本职位」+「快评」，`extractListPaneJd` 从右栏取描述全文，`currentActiveUrl` 以 `.job-card--active` 定位当前职位。
- **详情页**（`/jobdetail/{number}.htm`）：`evaluateInlineJd:true`，「评估本职位」+「快评」双按钮 + 已评估/快评双徽章，`extractDetailJd`、`extractPosterName`。
- **列表卡片**：已评估徽章（`DIV.job-card` 内右上）。**不激活批量勾选**——BOSS 的 `injectCheckbox`/`syncSelection` 本就 dormant，智联列表卡片只留徽章。
- **评估完成自动开报告**：`finalizeDetail` 是 core 站无关逻辑，智联自动继承，无需改。

### D3：职位 URL 数据源 = positionList，非卡片 DOM

`cardUrl(card)` 智联不能学 BOSS 从卡片 `<a>` 取 URL（卡片无职位锚点）。专属实现：以传入卡片（或 active 卡）在 `positionList` 中的 index / 标题匹配，返回对应 `positionUrl`。`positionUrl` 是完整绝对 URL，直接给。契约兼容——core 只要求 `cardUrl(card)` 返回 URL 字符串。

### D4：active 判定以 DOM 为准

读当前职位：`.job-card--active`（+右栏内容），**不用** `__INITIAL_STATE__.selectedJobId`（冻结快照不随动）。`currentActiveUrl` 与右栏描述提取都据此定位。

### D5：normalizeUrl 参数扩展

core `normalizeUrl` 的 `TRACKING_PARAMS` 全局集 + site `extraTrackingParams` 合并。智联清单：`refcode`、`srccode`、`preactionid`（页内跳转锚点携带，尤其 `preactionid` 每操作变）。`jl`/`kw` 是搜索页查询条件**保留**（它们标识一次搜索，但职位详情 URL `/jobdetail/{number}.htm` 本身无参数，故对已评估判定无影响）。

**后端同步**：`web/src/lib/core/url-key.mjs` 及根 `url-key.mjs` 的 `TRACKING_PARAMS` 加同一清单——`normalizeUrl` 的 key 必须两端一致，否则 `/api/report-status` 已评估判定漂移。byte 对齐约束 + parity 测试保持。

### D6：范围边界

本轮只做智联单站。架构（D1/D2）扩展点已成：再加站仍是一条 entry + 一个 site 文件。**不做**：`jobs.zhaopin.com/C{id}.html` 与 `www.zhaopin.com/jobdetail/{number}.htm` 跨格式归一（本期不合成同名 jobId 为一键；插件端评估走「卡片 URL → 详情页 `location.href`」，每格式内 key 自洽）；采集侧 `lib/zh-jobs.mjs` 的 `isZhJobDetailUrl` 正则已认 `jobdetail`/`job` 路径，继续沿用不改。

## 理由

- **右栏复用 BOSS 式**：智联两栏与 BOSS 同构，`ensureRightPaneButton`/`extractListPaneJd`/`currentActiveUrl` 三件套可直接搬，用户在两站操作一致。右栏有全文 → 列表快评成立，不浪费点进详情那一步。
- **positionList 作 URL 源**：卡片无职位 `<a>`，DOM 取不到职位 URL；`positionUrl` 是唯一可靠来源，且是完整绝对 URL、`positionList` 顺序与 DOM 卡片一致，可映射。
- **active 以 DOM 为准**：`selectedJobId` 不随动是实测事实，信它必错。
- **参数两端同步**：去重键一致是已评估判定的前提，沿用 ADR-0005 D7 的同款机制与 parity 测试。

## 取舍 / 风险

- **卡片-列表映射脆弱**：`cardUrl` 依赖 positionList 顺序与 DOM 卡片一致 + index 映射；SPA 懒加载/排序变化可能错位。mitigation：以 active 卡为准只映射当前一张，且用标题文本双保险；diag 上报 `cardHasLink`/`linkAnchors` 兜底排查。
- **`selectedJobId` 陷阱**：他人易误信快照。ADR 明记为决策，代码注释强调。
- **站点拼写 typo**：描述容器 `describtion-card`（非 description）照用实测 class，注释标注防顺手"修正"。
- **`positionUrl` 的 `http:`**：normalizeUrl 已强制 `https:` 协议，统一 keys 无碍。
- **跨格式不归一是显式 no**：未来若需求跨 www/jobs 合并，再做 jobId 抽取，本期不做（防过度设计）。

## 测试

分步验证（用户配合，登录态浏览器 + 未打包扩展）：

1. **BOSS/猎聘回归**：加载新 manifest（仍含三站 entry），BOSS 列表/详情、猎聘详情行为与改造前一致（core 未动，应零回归）。
2. **智联搜索页**：已登录 → 列表卡片出现已评估徽章；点击卡片右栏「评估本职位」出完整评估（`Verification: inline (DOM)`）、「快评」出紫徽章；`.job-card--active` 随点击移动。
3. **智联详情页**：直接开 `/jobdetail/{number}.htm` → 双按钮+双徽章定位正常，快评出分，评估出报告。
4. **后端 jdText**：curl `/api/batch-evaluate` 带 `jdText`+`company`（智联提取），验证跳过抓取、报告生成。

自动化：

- unit：`site-zhaopin.js` 选择器函数、`cardUrl` 的 positionList 映射、`normalizeUrl` 智联参数 strip（`refcode/srccode/preactionid`）、`isDetailPath`（`/jobdetail/`）、site 契约形状。
- 回归：url-key parity 测试不破（web 镜像与根同步智联清单）；web tsc + 既有测试全绿；`site-boss`/`site-liepin` 测试不受影响。
- 手工清单：三站各功能回归表。

## 实施记录

已落地并验证（2026-09-07）：

- **D1/D2**：新增 `extension/site-zhaopin.js`；manifest 加 zhaopin content_scripts entry（`https://*.zhaopin.com/*`）。
- **D2 右栏**：`ensureRightPaneButton`/`extractListPaneJd`/`currentActiveUrl` 三件套（智联右栏 `.job-detail-panel` 无 BOSS 的 `.job-detail-op` 操作栏，按钮以 absolute 锚到面板顶部右侧）。
- **D3/D4**：`cardUrl`/`currentActiveUrl` 从 `positionList[].positionUrl` 取职位 URL（卡片无职位 `<a>`），active 以 `.job-card--active` 定位（不信 `selectedJobId`）。`C`（core 引用）惰性赋值以兼容 node 测试桥。
- **D5**：`extraTrackingParams` = `refcode`/`srccode`/`preactionid`，同步进 `web/src/lib/core/url-key.mjs` 与根 `url-key.mjs`。
- **D8 相关**：background `notifyQuickUpdated`/`notifyContentScripts` 广播正则扩到 `zhaopin`。

### 自动化测试

- `web/tests/lib/zhaopin-site.test.mjs`（新增）：`isDetailPath`（`/jobdetail/{n}.htm` 精确正则、列表/companydetail 排除）、site 契约形状、`extraTrackingParams` 全量、右栏能力声明、`evaluateInlineJd`。
- `web/tests/lib/url-key.test.mjs`（扩展）：智联三参 strip → 干净 jobdetail URL、jl/kw 保留、web 镜像与 core parity。
- `site-zhaopin.js` node 测试桥（无 `window.__careerExtCore` 时 `module.exports` 纯函数），浏览器行为不变。
- 全量：web 491 测试通过（`node --test "tests/**/*.test.mjs"`），`npm run typecheck` 无错。

## Out of scope

- 智联批量评估（列表勾选）——BOSS 侧本就 dormant，不复刻。
- `jobs.zhaopin.com/C{id}.html` 与 `www.jobdetail` 跨格式归一，及业务 jobId 抽取合并。
- 移动端 / 非 Chromium 浏览器。