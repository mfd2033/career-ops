# ADR-0007：探索页浏览器扫描由职位评估扩展接管

- 状态：提议（Proposed）
- 日期：2026-09-09
- 相关：ADR-0001（浏览器全量采集的 Playwright/CDP 方案）、扩展驾驶的采集驱动切换

## 背景

ADR-0001 用 Playwright + 独立求职 profile 采集 BOSS/猎聘/智联，解决 bsk 无 trusted 滚轮致首屏 17 条的问题。但 Playwright 仍是「模拟外部浏览器块」：独立 profile 被用户日常登录挤下线（同账号多端挤压）、反爬指纹可能被识别、三平台子进程并发互相挤压。

现有职位评估扩展（`extension/`）已具备采集所需绝大部分基建：content script 跑在用户真实已登录浏览器（反爬豁免）、`MutationObserver` 监听懒加载卡片 DOM 变化（页面原生滚动即捕获，无需伪造滚轮事件）、每站 `site.cardSelector`/`cardUrl` 已配好、background.js 已连通本地 web（fetch + 端口探测 + 环回同源豁免）。缺口只在「驱动滚动 + 全量卡片元数据上报」。

## 决策

### E1：探索页 browser 模式采集驱动从 Playwright 改为扩展 content script

改造 `web/src/lib/core/browser-scan.ts` 的 `runBrowserDiscovery`：驱动方式换成扩展采集，保留 ExploreFilters/ScanEvent/落库契约与 UI 交互。Playwright/`zh-collect.mjs` 路径保留作未装插件的回退（E6）。

### E2：触发为「探索页发起」，目标 tab 复用用户真实登录态

探索页点「开始」→ 扩展 background 查既存 `zhipin|liepin|zhaopin` tab，命中即驱动；无则 `chrome.tabs.create` 开对应搜索 URL。复用真实登录态，不新开独立 profile（正本清源 D3 的「独立 profile」诉求，代价依赖用户装扩展）。

### E3：改 `browser-scan.ts` 集成边界，不做并行通道

一处改动讲通全链路：`runBrowserDiscovery` 内采集驱动换成扩展，保留 ScanEvent 进度面。理由：避免两套近似管线漂移、改动触及现有稳定代码需回归，但 Playwright 兜底仍保留于 E6。

### E4：按平台混合城市过滤

- **智联**：城市权威源 `positionList[].workCity`（window 状态数据，非 DOM）。采集循环快照一次 window 状态 → 建 `{归一URL → workCity}` 映射表，`cardMeta` 优先查表，查不到回退 title。根治 ADR-0001 时代 `extractCityFromText` 父链 ≤4 层漏匹配的坑。
- **猎聘/BOSS**：无卡片 city class，靠 title 匹配（复用 web 端 `matchesBrowserCity`）。

### E5：轮询上报 + 幂等 + 心跳保活

- **上报**：content script 分批 POST `/api/explore/add`（复用现落库，零改动），不是流式 NDJSON（SW 生命周期约束流式脆）。前端每 2s 轮询 whats-new 对比新增数作进度。
- **幂等**：两层。content script 本页已采 URL Set 只发增量不重报；web 端对单次扫描 `scanId` 做幂等键防前端连点。因 `addOffersToPipeline` 不去重（直接 append pipeline.md + scan-history.tsv），幂等必须在插件/路由侧兜底。
- **保活**：采集分批上报本身即活动事件，间隔持续唤醒 background SW，无需额外 keepalive。
- **批大小**：50 条/批 + 2s 节流，防风控。

### E6：未装插件回退降级

- 探测扩展连通：可连通 → 走 E2 开 tab 采集；不可连通 → 回退现有 Playwright/`zh-collect.mjs`。扩展是可选项增强，不是硬前提。

### E7：采集终止条件与上限

任一即停：满上限（默认 **400**，提高自 ADR-0001 的 200）、连续 8s 无新卡片（懒加载到头）、页面无可见滚动区。扫描期间用户可自由接管滚动/翻页（content script 滚动是页面内 trusted 事件，无锁），采集只读，不隐藏已注入徽章。

### E8：每站卡片元字段 = 新增 `cardMeta(card)`

`sitepx` 三站各新增 `cardMeta(card)` 返回 `{url, title, company, salary, city?}`（现 `cardUrl` 只给 url）。字段来源：卡片内稳定锚点抽 title/company/salary；city 走 E4。去重键用 `core.normalizeUrl`（复用，已处理跟踪参数）。

## 理由

- 扩展 content script 的 `MutationObserver` 捕获的是页面自身 DOM 变化——数据完整性来自页面真实渲染而非伪造输入，比 Playwright 模拟滚轮更稳，天然拿满懒加载全量（对 ADR-0001 的「127 条」有底气续增）。
- 用户真实浏览器 + 真实登录态 = 反爬豁免、无独立 profile 多端挤下线问题。
- 三平台各 tab 独立采集，天然并发，无子进程互相挤压。
- 复用现落库与 ScanEvent 契约，改动集中在驱动层。
- Playwright 兜底守老用户与零装机门槛。

## 取舍 / 风险

- 依赖用户安装并启用职位评估扩展；未装时回退 Playwright（数据完整性退回 127 条级）。
- /api/explore/add 不去重，幂等责任前置到插件与路由 scanId，需防两处实现漂移。
- content script 在真实页面滚动，用户注意「页面被自动滚动」的观感，可接受。
- 智联 workCity 映射依赖 window 状态快照时机，SPA 首屏未渲染完快照可能缺 key，需重采兜底。

## 测试

- content script 采集逻辑：pure 单测 `cardMeta` 字段提取、URL Set 增量去重（复用现有 site 测试骨架，如 `zhaopin-site.test.mjs`/`liepin-site.test.mjs`）。
- 幂等：路由 scanId 重复 POST 单测只写一次。
- 集成冒烟：真实 Edge 装扩展跑一次猎聘/BOSS/智联各一关键词，条数 ≥127（对 ADR-0001 基准）验证数据完整性。
- 上层：`browser-scan.ts` 驱动 seam 替换后 tsc + 现有 web/扩展测试全绿。

## Out of scope

- 三平台 App/API 签名逆向。
- 扫描中途实时登录兜底（沿用 D5：中途失效按平台失败处理）。
- 移除 Playwright 兜底路径（保留至扩展装机率足够高后再评估）。