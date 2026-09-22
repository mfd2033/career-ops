# ADR-0050: 工具栏连接状态徽章（chrome.action badge 外显本地 web 服务在线状态）

## 状态

Accepted (2026-09-22)

## 背景

`职位评估` 浏览器扩展（`extension/`）与本地 `career-dashboard` web 服务之间的连接状态，目前**只有点开 popup 才看得到**：`background.js` 的 `probePort()/ensureLivePort()` 扫描 `127.0.0.1:3000-3040` 的 `GET /api/version` 判断服务是否在线，结果缓存在 `cachedPort`；`popup.js` 在 `init()` 里发 `get-state` 消息读取该结果，渲染成「已连接 localhost:{port}」或「未检测到本地 web 服务」（`popup.js` 36–50 行）。

用户诉求：不点开插件、在浏览器工具栏上就能瞄一眼连接状态。扩展工具栏图标（`chrome.action`）当前无任何徽章。

约束：

1. 连接状态是本地 web 服务的**全局属性**（机器级），不是某个标签页独有的。
2. 判定「已连接」沿用现有**严格版本校验**——`/api/version` 须返回合法 `version` 字段，避免误连其他占用 3000-3040 的本地服务。
3. 全端口扫描一次覆盖 41 个端口，不能每次切标签页都无脑重扫。
4. service worker 会被 Chrome 休眠，但 `chrome.action` 徽章文本/颜色由浏览器持久保存，SW 重启后徽章仍在，直到下一次主动更新。

## 决策

1. **显示位置**：用 Chrome 原生 `chrome.action.setBadgeText` + `setBadgeBackgroundColor`，直接在工具栏插件图标上外显状态。不注入任何页面内浮动小部件，`content_scripts` 不改。
2. **作用范围**：**全局常显**——`setBadgeText`/`setBadgeBackgroundColor` 调用时不带 `tabId`，切到任何标签页徽章都代表同一个服务器状态。
3. **视觉编码**：
   - 已连接 = **绿底 + `✓`**；
   - 未连接 = **红底 + `!`**（ASCII，渲染最稳）；
   - 探测中（probing）**不单独显示**，只在结果确定后一次性更新，避免闪烁。
   - `✓` 属非 ASCII，个别 Chrome 徽章字体可能空白，实现内置 ASCII 降级（渲染异常时连上改用绿底无字或 `ok`）。
4. **异常中间态合并**：只要端口无命中、或端口响应但 `/api/version` 非法/接口异常，一律归为**未连接（红）**，不引入第三种「服务异常」颜色。二值状态，与严格版本校验一致。
5. **更新触发（全面事件集）**：以下时机各调一次 `updateBadge()`——
   - `chrome.runtime.onInstalled` / `chrome.runtime.onStartup`（冷启动即点亮，不依赖用户先开 popup）；
   - `chrome.tabs.onActivated`（切标签页）；
   - `chrome.tabs.onUpdated` 且 `changeInfo.status === "complete"`（页面加载完成）；
   - 批量评估结束（popup 收到 `done`/`error` 后广播回 background）；
   - popup 手动 reprobe（`get-state` 带 `force`）之后。
6. **节流**：`updateBadge()` 对同一探测结果加 **5s 短缓存**——5 秒内重复事件不重新发起全端口扫描，直接复用上次结果刷新徽章。代价是服务挂掉后徽章最多延迟约 5s 才转红，可接受。
7. **数据源复用**：`updateBadge()` 内部直接调用现有 `ensureLivePort().catch(() => null)`——拿到端口即绿、拿到 `null` 即红。不新增探测逻辑，不改 `popup.js` 现有 `get-state` 通路（popup 文案与徽章只是读取同一状态，互不影响）。
8. **权限**：**无需新增**。`storage/tabs/scripting` 已够；事件驱动方案不引入 `alarms`。`manifest.json` 的 `permissions`/`host_permissions` 保持不变。

## 后果

- 正面：连接状态零点击可见；扩展安装/浏览器启动即点亮徽章；服务宕机在下次页面事件（≤5s 缓存窗口）内转红。改动集中在 `background.js` 新增一个 `updateBadge()` 函数与若干事件监听挂载点，`popup.js`、`content_scripts`、`manifest.json` 均不动。
- 代价：事件驱动而非轮询，意味着「用户完全无操作且服务在后台挂掉」时徽章不会自动转红，须等下一次页面事件；这是选择事件驱动（省资源、无需 alarms 权限）换取的确定性权衡。
- 后续（非本次范围）：若实时性诉求升高，可另立 ADR 引入 `chrome.alarms` 做低频兜底轮询；徽章文案可随 `language.output` 本地化。

## References

- ADR-0002（BOSS 就地评估——`background.js` 端口探测与消息中枢的由来）、ADR-0005/0006/0007（猎聘/智联/探索扫描对同一 background 的续建）。
- `extension/background.js`（`probePort`/`ensureLivePort`/`cachedPort` 所在，新增 `updateBadge()` 挂载点）、`extension/popup.js`（`get-state` 连接状态渲染，36–50 行，本 ADR 不改动其逻辑）。
- 术语表：`docs/glossary-browser-extension.md`（「web 端口探测」「background service worker」「popup」词条，本次新增「工具栏连接状态徽章」）。
