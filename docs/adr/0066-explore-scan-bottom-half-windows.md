# ADR-0066: 探索页浏览器扫描改为下半屏多窗口平铺——单关键词 + 收尾自动关窗

- **Status:** Accepted (2026-10-01)
- **Context:** 需求（2026-10-01，一轮 grilling 敲定）：「在探索页扫描时会根据选择的平台打开多个 tab，期望打开 tab 时，还留在当前扫描的 tab，就像按着 ctrl 键点击链接一样」。经 grilling 收敛为「每平台一个独立小窗口、铺满下半屏、扫完自动关窗」的方案，而非原话的「后台 tab」。现状与约束：

  1. **现开 tab 即抢焦点**：扩展驱动采集在 [openAndDrive](../../extension/background.js) 里 `chrome.tabs.create({ url })`——默认 `active: true`，焦点跳到新 tab；三平台顺序驱动时焦点来回弹。
  2. **后台 tab 会被 Chrome 节流**：采集循环靠 content script 里 900ms 的 `setInterval(scanTick)` 自动滚动 + 收集（[core.js](../../extension/core.js)）。Chrome 把非活动（hidden）标签页的 `setInterval` 节流到约 1 次/分钟——若简单改 `active: false` 开后台 tab，采集几乎停摆。**每平台独立可见窗口**规避此坑：某窗口即便未聚焦，只要其窗口在屏上可见，其活动 tab 不算 hidden，定时器不被降到 1/分钟。
  3. **窗口数不固定为 3**：[explore-provider.tsx](../../web/src/components/explore/explore-provider.tsx) `driveViaExtension` 里 `query.replace(/\s+/g," OR ")` + `expandSearchTargets` 对猎聘按词拆成多条搜索 URL，一个平台可占多窗口。**决议「关键词限单个词」**后：单词无空格 → 不 OR、不拆词 → 窗口数 = 选中平台数 ≤ 3（BOSS/猎聘/智联各一）。
  4. **收尾语义要翻转**：ADR-0007 E9 的收尾 = 「扫完把焦点切回探索页 tab、从不关闭采集 tab」，其存在前提正是「开 tab 会抢焦点」。多窗口不抢焦点（焦点本就可留在探索页窗口的上半屏），E9 的切焦点动作失去意义，替换为「自动关窗」。
  5. **manifest 无 `system.display`**：现权限仅 `storage,tabs,scripting`。屏幕尺寸不新增权限，由探索页前端用 `window.screen` 读取并随 drive-scan 消息下发窗口 bounds。

- **Scope:**
  - `extension/background.js`：`openAndDrive` 由 `chrome.tabs.create` 换 `chrome.windows.create`（带 bounds、记 `windowId`）；收尾 `runWrapUp` 从「切回探索页」改「按保护规则关闭本次开出的平台窗口」；`activeDrives` 登记加 `windowId` 与 `originalUrl`。
  - `extension/wrapup-pure.js`：新增 `decideCloseWindows` 纯判定（哪些窗口关、哪些留）；`decideWrapUp` 去掉 `wrapUpEnabled` / `activateTabId` 分支，仅保留「本次扫描是否全部结束（settle）」的归口。
  - `web/src/components/explore/explore-provider.tsx` `driveViaExtension`：发起前做单关键词校验；用 `window.screen` 为每个 target 计算 bounds 随消息下发；drive 消息去掉 `wrapUp` 字段。
  - `web/src/components/explore/filter-builder.tsx`：browser 模式 zhQuery 输入的多词提示文案（配合提交校验）。
  - 移除「扫描收尾」配置开关：`web/src/lib/scan-wrapup.mjs`（`readScanWrapUp`/`SCAN_WRAPUP_FIELD`）、`config-form.tsx` 开关控件、`config.ts` i18n（`scanWrapUp*` 三键）、drive-scan 消息侧 `wrapUp`。
  - 更新 ADR-0007 E9 文末指向本 ADR。
  - **不动**：ATS 纯 HTTP 扫描（不开任何窗口）、bsk CLI 兜底路径（走独立 Playwright 浏览器，非用户 Chrome）、AI 模式、采集内容脚本本身（`core.js`/`site-*.js`）、落库与 ScanEvent 契约。

## Decision

1. **单关键词硬约束（提交时校验报错）**：浏览器扫描的关键词只允许一个词。含空格/多词 → 提交时报「只支持单个关键词」，要求改正，**不静默截断**（避免用户以为搜了多词）。附带收益：把窗口数钉死为 ≤3，布局恒为一行。
2. **每平台一个独立窗口，铺满下半屏**：`chrome.windows.create({ url, left, top, width, height })`，`focused` 用默认（可抢焦点，用户明确接受——上半屏仍看得见探索页进度）。**不复用既存站点 tab，每次新开干净窗口**；登录态靠同浏览器 profile 的 cookie 自然共享。
3. **宽度按 N 平分整行**：窗口宽 = 可用屏宽 / N（N=选中平台数，1 个满宽 / 2 个各半 / 3 个各 ⅓），高 = 可用屏高 / 2，铺在屏幕下半部（`top = 可用顶 + 可用高/2`）。尺寸以探索页所在显示器为准，用 CSS px（= Chrome bounds 的 DIP，无需 `devicePixelRatio` 换算）。
4. **扫完自动关窗 + 两类保护**：本次 scanId 全部驱动 settle 后，关掉本次开出的平台窗口，但保留：① 用户已接管的窗口（当前 tab URL 已离开其原始搜索列表页——host 变更或进入职位详情页。**不识别「翻页/筛选」**：站点自身会改写列表页 URL（如 BOSS 列表路径单复数改写），与用户手动翻页/改筛选无法可靠区分，宁可漏保护也不误关用户正在看的窗口）；② 仍停在登录页/滑块验证页的窗口（URL 命中该站登录/验证特征）。探索页被关（中止采集）时同样关窗，保护规则一致。最后一个窗口关闭后把焦点还给探索页所在窗口。
5. **移除旧「扫描收尾」开关，行为固定**：E9 的切焦点开关连同 `wrapUp` 消息字段、i18n、`scan-wrapup.mjs` 一并删除；新行为（自动关窗 + 保护）不可配。
6. **仅扩展浏览器路径**：以上只作用于扩展驱动的国内平台采集；ATS/bsk/AI 路径零改动。

## Alternatives considered

- **后台开 tab（`active:false`）**：最贴用户原话「像 ctrl 点击」，改动最小。否——Chrome 把 hidden tab 的 900ms 采集循环节流到 ~1/分钟，采几乎停摆，等于用「焦点不跳」换「扫不出东西」。
- **防节流 hack（后台静默音频 / SW 驱动采集循环）**：能保住后台 tab 全速，但要么注入音频（页面观感怪、可能被站点策略拦），要么把 content 的滚动循环重构到不受节流的 SW 侧（触及稳定采集核心，回归面大）。多窗口方案用「可见窗口不节流」这一浏览器既成规则零成本绕开，故取多窗口。
- **保留既存 tab 复用逻辑**：省得重开，但布局不可控（既存 tab 在别的窗口/位置），与「铺满下半屏成网格」冲突；用户选「每次新开」。
- **保留旧收尾开关做兼容**：E9 开关语义已与「切焦点」绑定，多窗口下无意义，留着是死配置，用户选直接移除。
- **多行网格 / 固定 ⅓ 宽留白**：`expandSearchTargets` 拆词可致 N>3 时才有必要；决议 1 把 N 钉死 ≤3，一行足够，不引入换行复杂度。
- **`system.display` 取屏幕尺寸**：更准（多显示器/DPI），但要新增权限、走 SW 异步。`window.screen` 在环回页面可读且够用一个显示器场景，否。

## Consequences

- 扫描时桌面下半屏被平台窗口占满（最多 3 个），上半屏保留探索页进度——用户明确接受「新窗口可抢焦点」。
- 一次一词削弱多关键词广度覆盖：换来布局确定性与采集全速，属用户知情取舍；要多词需多次扫。
- 采集窗口生命周期与「是否被用户接管」耦合：URL 判定误报（例如站点自身把列表 URL 规范化改写）会漏关一个窗口——代价只是多留一个空窗口，不丢数据，可接受。
- `activeDrives` 登记从「tab」扩到「tab + window」；`endDrivesForTab` / onRemoved 需按 windowId 一并清理。
- 旧收尾的 `wrappedUpScans` 幂等账保留（防迟到 scan-done 重复关窗）。

## Test Plan

- `wrapup-pure.js` 纯单测（`web/tests/lib/wrapup-pure.test.mjs` 续写）：
  - `decideWrapUp` 去掉开关/切焦点后仍正确按 scanId 归口 settle；
  - 新增 `decideCloseWindows`：正常列表页→关；URL 变更→留；登录/验证 URL→留；混合只关应关的那些；无 scanId 归属不动。
- 前端 bounds 计算：给定 `window.screen`（1920×1080）与 N=1/2/3，断言各 target 的 `left/top/width/height`（下半屏、等宽）。
- 单关键词校验：多词提交报错、单词放行（组件/逻辑层断言，含 zhQuery 前后空格）。
- 扩展 `openAndDrive`：`chrome.windows.create` 收到 bounds、登记带 windowId/originalUrl（可用桩 chrome 或标注为集成冒烟）。
- 移除项：全局 grep `scanWrapUp`/`readScanWrapUp`/`wrapUp:` 无残留引用；`npm --prefix web run typecheck` + `npm --prefix web test` 全绿。
- 集成冒烟（真实 Chrome 装扩展）：选 BOSS+智联两平台单词扫一次 → 下半屏并排两个窗口、采满、扫完自动关两个窗口、焦点回探索页；猎聘单词停登录页 → 该窗口不被关。

## References

- `extension/background.js`（`openAndDrive`、`driveSource`、`driveScan`、`runWrapUp`、`endDrivesForTab`、`activeDrives`）、`extension/wrapup-pure.js`、`extension/core.js`（采集循环节流点）。
- `web/src/components/explore/explore-provider.tsx`（`driveViaExtension`）、`web/src/components/explore/filter-builder.tsx`（zhQuery）、`web/src/lib/scan-wrapup.mjs`、`web/src/lib/browser-search.mjs`（`expandSearchTargets`）。
- 前置：ADR-0007（E2 开 tab 驱动、E9 旧收尾、E10 存活探测）、ADR-0029（browser 城市门）、ADR-0069（逐平台进度）。
