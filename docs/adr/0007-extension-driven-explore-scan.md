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

### E9：扫描收尾 = 把焦点切回探索页 tab（可关），探索页被关则中止采集

E2 只说了怎么开 tab，没说采完之后把用户放在哪——实际结果是用户停在扩展最后打开的那个招聘站 tab 上，而结果渲染在他已经离开的探索页里，等于"采完了但找不到结果"。E9 补这一段。

**正常收尾**（本次扫描的 `scan-done` 到齐、属于本次 scanId 的登记都摘掉）：

- **唯一动作是 `chrome.tabs.update(探索页 tabId, {active:true})`**，按 scanId 幂等一次。
- **「本次采完了没有」按 scanId 归口**，不是看整张登记表空不空。两个方向都必要：拆词扫描（猎聘一个关键词一条搜索 URL）下同一次扫描有多条驱动，任何一条还在跑就都还没结束；反过来，别的 scanId 的残留登记（极端情况下 tab 消失得连 `onRemoved` 都没赶上）不能把本次扫描永远压住。
- **不调 `windows.update({focused:true})`**：浏览器被放在后台时（用户在别的应用里工作）不该把窗口拽到前台，但 active tab 要切——用户主动切回浏览器时应该落在探索页看结果，而不是停在那几个招聘站 tab 上。
- **不关闭采集 tab**：E2 的意图是复用用户既存的三站 tab（当前实现是无条件新开，复用尚未落地）。一旦落地复用，收尾关 tab 就从"清场"变成"删掉用户自己开着的页面"，这个动作不可逆，所以从一开始就不做。
- **探索页 tab 已不存在（用户关了它）→ 静默跳过**：用户关掉页面等于放弃这次结果；替他重开一个 tab 属自作主张。失效 tabId 的 reject 必须被吞掉，不能炸进 `scan-done` 的响应路径。
- **触发在 SW 侧，不由前端驱动**：前端那条 2s 轮询（`scan-status` + `/api/explore/scan-progress`）只负责展示进度。让前端在轮询到"active 为空"时通知 SW 会把收尾绑在页面存活的假设上（页面被刷新/关闭即永不触发）。
- 收尾开关放配置页，默认开，只关"切焦点"这一件。

**探索页 tab 被关闭（`tabs.onRemoved`）→ 中止采集**：探索页没了，结果就再也看不到（结果只活在原 tab 的 React state 与 per-tab sessionStorage 里；`relayScanBatch` 虽在 SW 侧、采集数据照常入库，但展示面已死），继续滚下去只是浪费。SW 向 `activeDrives` 里各采集 tab 发 `stop-scan`——这个消息处理器早已存在于 content script（`finishScan("stopped")`），此前无任何发送方。`finishScan` 会把池中剩余一次性上报，故**已采到的照常落 `pipeline.md`**：中止的是"继续采"，不是"丢掉已采"。本动作**不**受收尾开关管辖——它省的是浪费，与用户的展示偏好无关。

**没有 `scan-done` 的结束路径**（否则收尾永不触发，共三条）：

- **采集 tab 中途被关**：`tabs.onRemoved` 摘除该 key 登记。这同时修掉一个既有缺陷——残留登记会让 `scan-status` 永久报告该平台 active，前端轮询固定空转到 180s 兜底才退出；残留登记还会让下一次扫描对同一 `(source,url)` 直接返回 `active` 而静默不驱动任何东西。
- **全部平台启动即失败**：`openAndDrive` 是先 `chrome.tabs.create` 再向 content 握手，启动失败时 tab 保留（只摘登记），用户已经被带到那个空 tab 上；`driveScan` 结束后若本次没有任何成功登记，立刻走同一个收尾函数。
- **采集端静默死亡**（反爬整页跳走）：前两条都假定"采集端的死法会通过某个事件告诉我们"，而反爬制造的第三种死法两个事件都不产生——见 E10。

**被否掉的替代方案**：①关闭采集 tab（见上，不可逆）；②`windows.update({focused:true})` 无条件抢窗口（打断用户）；③探索页被关后重开 `/explore`（重开的页面看不到本次结果——结果不在服务端也不在 whats-new 里，已在 `pipeline.md` 的行会被 `/api/whats-new` 主动排除，所以那不是"恢复结果"而是"恢复一个空表单"）；④用 `scan-status` 轮询超时反推页面已死（MV3 无活动时 SW 会睡，停止时机退化到 `chrome.alarms` 的 30s 颗粒度）。

### E10：收尾的第三个触发点 —— 采集端存活探测

E9 的两个触发点（`scan-done` / `tabs.onRemoved`）都假定"采集端的死法会通过某个事件告诉我们"。反爬制造出第三种死法，两个事件都不产生：**整页跳到验证页 / 安全中心 / 换域名**——content script 连同它的两个定时器一起被销毁，`scan-done` 永远发不出来；tab 还开着，`onRemoved` 也不会来。结果是登记一直留着、收尾永不触发、用户停在验证页上（探索页那边 180s 兜底后页面状态已恢复正常，只是焦点不动）。这恰好是这三站最常见的一种结局，不是极端情况。

**机制**：借探索页已有的 2s `scan-status` 轮询顺手探活——后台向每条**已完成启动握手**的登记发 `scan-ping`，content script 按自己实例的采集状态回答（被站点重注入的新实例没有采集状态，如实答否）。答不出（`sendMessage` 抛错：tab 已关、content 没注入、页面上没有我们的脚本）或答「不在采集」→ 该登记按结束处理：摘登记 + 走 E9 的收尾。

**取舍**：

- **fail-closed：无应答也判死**。漏判会让收尾永远不触发（正是要修的洞），误判的代价只是提前收尾（停采集 + 切回探索页，用户可重扫，不丢已采数据、不动任何 tab）。已知误伤面是"站点自身整页重载"，但采集路径不依赖整页重载——否则现有采集循环本来也活不过翻页。
- **握手前不探**：登记带 `started` 标记，握上手才置真；未握手的登记不参与探活，否则每次启动都会被自己误判成死亡（`chrome.tabs.create` 之后到 content 注入之间必然有一段无应答窗口）。
- **挂在轮询上，不做独立定时器**：2s 轮询正好等于"探索页还活着"的区间；探索页自己被关的场景已由 E9 的 `onRemoved` 覆盖。独立定时器在 MV3 下要 `chrome.alarms`（最小 30s 颗粒度），既慢又多一套基建。

**被否掉的替代方案**：①`tabs.onUpdated` 按 URL 变化判死——站点自身翻页/筛选就会改 URL（猎聘翻页改 `d_curPage` 等），这种噪声无法与"跳验证页"区分；②`tabs.onUpdated` 只判跨 host 或详情页 pathname——覆盖不到同 host 的验证页；③content script 加载时主动上报"我是新页面、没有采集状态"——与启动握手存在竞态（登记先于握手建立，先上报会被当成死亡），要额外引入时序护栏。

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