# ADR-0055: 报告跳转复用已打开的 web 端标签页（open-report 不再无条件新建标签页）

## 状态

Accepted (2026-09-23)

## 背景

`职位评估` 扩展在招聘站页面上的两个「已评估」评分徽章——列表卡片徽章（`extension/core.js` 的 `injectBadge`，点击处理器见 212–216 行）与详情页固定徽章（`refreshDetailBadge`，点击处理器见 426–430 行）——都调用同一个 `openReport(num)`（`core.js` 175–181 行），后者发 `open-report` 消息给 background service worker。SW 侧实现（`extension/background.js` 636–653 行）是：

1. `await ensureLivePort()` 取存活端口；
2. 拼 `http://localhost:${port}/report/${num}`；
3. `await chrome.tabs.create({ url: reportUrl })`。

即**每次都开一个新标签页**。第三条调用路径是单职位评估完成后的自动跳转：`finalizeDetail`（`core.js` 486–499 行）在评估命中后 `setTimeout(() => openReport(entry.reportNum), 400)`，并 toast「…报告 #N，已打开」。

用户诉求：在招聘站列表页/详情页点评分徽章时**不要在浏览器里再开一个新标签页**，而是把报告开在**已经打开的那个 web 端**（本地 career-ops dashboard 标签页）里。日常使用中 web 端本来就常年开着，看报告时反复累积标签页是主要痛点。

约束与已知事实：

1. web 端 origin 按家规（`modes/_custom.md`）是 `http://localhost:{3000-3040}`，用户手敲 IP 时则是 `http://127.0.0.1:{3000-3040}`；两者是不同 origin，同一台机器上可能同时存在。
2. `ensureLivePort()` 返回的是**存活端口**，与「当前正开着页面的那个 web 标签页」的端口未必是同一个；「web 服务在跑」与「web 页面开着」是两件独立的事。
3. 扩展对 web 端身份**没有校验手段**：`extension/web-bridge.js` 只被动转发带 `__careerExt:req` 标签的 `window.postMessage`（web→扩展单向），不响应 SW 的主动询问。
4. `tab.lastAccessed` 只在 Chrome 121+ 提供，而 `extension/manifest.json` 现在写的是 `"minimum_chrome_version": "110"`。
5. 仓库既有先例 ADR-0050：在真实浏览器里难以稳定复现的判断抽成 `*-pure.js`（不引用 `chrome`/`window`/`document`）并配 node 单测，单测落在 `web/tests/lib/`。

## 决策

1. **复用优先于新建**。`open-report` 不再无条件 `chrome.tabs.create`：先解析出一个可复用的 web 端标签页，只有解析不出来时才退回新建。
2. **识别口径 = 仅 origin + 端口区间粗判**。候选标签页的 URL 协议为 `http`、主机为 `localhost` 或 `127.0.0.1`、端口落在 `3000-3040` 即视为本项目 web 端。不引入 `whoami` 握手、不在 web 侧做任何改动、不要求扩展与 web 版本同步。已知残留风险：若有另一个项目恰好占用同区间端口，可能被误当作 web 端并导航——家规已把区间限定得足够窄，接受该风险。
3. **候选优先级**：先取 origin 端口等于本次 `ensureLivePort()` 存活端口的候选（避免把报告开进另一个实例）；没有则退到任意候选。
4. **多候选的「最近活跃」用近似规则**，不依赖 `tab.lastAccessed`：当前窗口内处于 active 的候选 → 当前窗口内第一个候选 → 全库第一个。`manifest.json` 的 `minimum_chrome_version` 保持 `110`，不为精确判定抬高版本门槛。
5. **导航方式 = 整页导航**。复用目标用 `chrome.tabs.update(tabId, { url })` 直接导航到 `http://localhost:{port}/report/{num}`。**不做**前端路由跳转或报告抽屉：不新增扩展→web 的反向消息通道，web 侧零改动。已知代价：该标签页当前页面状态（正在编辑的 CV 草稿、pipeline 的筛选与滚动位置）会被整页重载冲掉——这是换取最小改动面的显式取舍。
6. **同 URL 幂等**：目标标签页当前 URL 已等于目标报告 URL 时，只做激活聚焦，不重新导航，避免在同一个报告上反复点徽章造成的无意义闪白与状态重置。
7. **激活与聚焦**：复用路径执行 `chrome.tabs.update(tabId, { active: true })` + `chrome.windows.update(windowId, { focused: true })`；**不** `tabs.move` 把标签页搬到招聘站所在窗口（搬家会打乱用户自己的窗口/标签布局）。招聘站页面一律不动、不关，用户切回去仍在原职位页。
8. **兜底口径（两条分支，互不混同）**：
   - **端口探测失败**（`ensureLivePort()` 抛错或返回空）：不复用任何已开标签页，维持今天的报错 toast「本地报告打不开：本地 web 服务可能未运行」，也不新建标签页。把一个已经连不上的页面推到用户面前，比直说「web 服务没跑」更令人困惑。
   - **端口存活但没有任何候选标签页**：退回 `chrome.tabs.create` 新建标签页到报告 URL，与今天行为一致，用户不会因为忘了开 web 端而点不动徽章。
9. **改动范围 = 三处调用点统一**。列表卡片徽章、详情页徽章、`finalizeDetail` 评估完成自动跳转全部走同一套解析逻辑；`finalizeDetail` 的 toast 文案随之校正，使其在「复用」与「新开」两种结果下都成立。
10. **验证 = 纯函数 + node 单测**。把候选过滤、优先级排序、同 URL 幂等判定、兜底分支抽成新的 `*-pure.js`（沿用 `extension/badge-pure.js` 的 `self`/`module.exports` 双导出口径，严禁引用 `chrome`/`window`/`document`/`location`），单测落在 `web/tests/lib/`（同 `badge-pure.test.mjs` 口径）。`chrome.tabs`/`chrome.windows` 调用层只做真实浏览器手工验证。
11. **权限与清单不变**。`tabs` 权限已具备，不需要新增权限，不引入 `windows` 权限相关改动；`manifest.json` 的 `permissions`/`host_permissions`/`minimum_chrome_version` 均保持原样（描述里「点击徽章跳本地报告页」的说法仍然成立，无需改写）。
12. **术语表同步**：`docs/glossary-browser-extension.md` 的「本地服务与安全」节新增「web 端标签页复用」与「报告跳转目标解析」两个词条。

## 修订 (2026-09-23)：复用改为「前端路由优先，回退整页导航」

**修订 决策 5，并连带作废「后果」里的代价 1。** 验收时复现结论：切到已打开的 web 端这一步生效了，但**原页面被整页重载刷掉**——正是决策 5 写下的显式代价，用户在真实使用中判定不值得（正在编辑的内容、pipeline 的筛选与滚动位置都会丢）。

决议：

1. **复用分支不再整页导航，改请 web 端自己跳**（决策 5 的「前端路由优先，回退直接导航」）：
   - SW 先 `chrome.tabs.update(tabId, { active: true })` + `chrome.windows.update(windowId, { focused: true })` 把目标标签页提到前台（聚焦先于跳转，点击立即有反馈）；
   - `navigate=true` 时发 `chrome.tabs.sendMessage(tabId, { type: "career-navigate", path })`，由 web 端 `router.push(path)` 做客户端跳转，**不刷新页面**；
   - web 端没应声（旧版本 web / 尚未 hydrate / content script 不在）→ 回退 `chrome.tabs.update(tabId, { url, active: true })` 整页导航，功能不因此消失。
   - `navigate=false`（已在同一报告页）仍只聚焦，连消息都不发（决策 6 不变）。
2. **新增一条扩展 → web 的反向通道**（ADR-0007 定义的单向桥在此扩为双向，仍是同一 `__careerExt` 命名空间、同一注入点，不新增 content script）：
   - `extension/web-bridge.js`：新增 `chrome.runtime.onMessage` 入口，收 `career-navigate` 后 `window.postMessage({ tag: "__careerExt:nav", id, path })`；页面回 `__careerExt:nav-ack` 才 `sendResponse({ ok: true })`，**800ms 超时应答 `{ ok: false }`**（旧版 web 没有监听器时必须让 SW 走回退）；
   - `web/src/components/ext-nav-bridge.tsx`（新组件，挂在根 layout，见 `web/src/app/layout.tsx`）：监听 `__careerExt:nav` → `router.push(path)` → 回 ack；
   - SW 侧另加 1200ms 的比赛超时（`navigateInWebTab`），保证坏掉的 content script 不会把点击悬在半空。
3. **`path` 由纯逻辑层产出**：`report-target-pure.js` 新增 `reportPath(num)`，`create`/`reuse` 结果同时带 `url` 与 `path`（`url` 必须以 `path` 收尾），让前端路由目标与回退 URL 永远指向同一张报告；该文件的其余判断与既有 17 条单测不变（只新增 `path` 断言）。
4. **路由目标白名单**：页面侧只接受 `^/report/[0-9]{1,6}$`，不匹配一律**不应答**（让 SW 回退到它自己拼好的 URL）。窗口消息对页面内任何脚本可见，Next 文档亦明确禁止把未消毒的 URL 交给 `router.push`（`javascript:` 会在本页上下文执行）。
5. **决策 1-4、6-11 全部不变**：候选口径仍只做 origin + 端口区间粗判，端口探测失败仍直接报错不跳转，无候选仍退回新建标签页，权限与 `manifest.json` 仍不动。

代价（自适应修订后的取舍）：

- 扩展与本地 web 自此有版本耦合：**只更新扩展、web 端停在旧版**时，每次点击都会多吃一次 800ms 等待再回退整页导航（功能正常，只是慢）；两边一起更新才是完整效果。
- 引入了一个新的跨层消息契约（`career-navigate` / `__careerExt:nav` / `nav-ack`），是 ADR-0007 之外的第一条扩展 → web 主动指令通道，需要按「新通道」对待：它只能携带报告路由，不承载任何其它动作。
- 前端路由跳转丢掉了整页重载的「确知成功」语义：ack 只证明「消息被收到、跳转已发起」，报告不存在时是 web 端自己去 404（与手动点进该路由一致）。

## 后果（初版：修订前的状态，修订节已覆盖其中代价 1 与「web 端零改动」的说法）

- 正面：看报告不再累积标签页；web 端常年开着时，点击徽章就是「切过去看到报告」一步；改动集中在 `background.js` 的 `open-report` 分支、`core.js` 的 toast 文案，以及一个新的纯函数文件；初版不动 `manifest.json`、`web-bridge.js` 与整个 web 应用。
- 代价：
  1. 整页导航会丢弃目标 web 标签页当前的页面状态（决策 5 的显式取舍）——**已由上方修订作废**；
  2. 身份识别是粗判，同区间端口被别的项目占用时可能误判（决策 2 的显式取舍）；
  3. 近似「最近活跃」规则在多个 web 端标签页共存时的精确度低于 `tab.lastAccessed`（决策 4 的显式取舍）。
- 后续（非本次范围，各自需要时另立 ADR）：引入 `whoami` 握手做精确身份校验；把 web 端标签页显式登记为固定跳转目标；用 `tab.lastAccessed` 精确判定并相应抬高最低 Chrome 版本。（「改为前端路由跳转」原本列在这里，已由上方修订实施。）

## References

- ADR-0050（同一扩展的纯函数 + node 单测口径先例）、ADR-0002（`open-report` 与 `background.js` 端口探测链路由来）、ADR-0007（`web-bridge.js` 转发通道的由来；修订节把它从单向扩为双向）。
- `extension/core.js`（`openReport` / `injectBadge` / `refreshDetailBadge` / `finalizeDetail`）、本次新增的 `extension/report-target-pure.js`、`extension/background.js`（`open-report` 分支、`navigateInWebTab`、`ensureLivePort`）、`extension/web-bridge.js`（`career-navigate` 入口，修订节新增）、`web/src/components/ext-nav-bridge.tsx` + `web/src/app/layout.tsx`（修订节新增的页面侧监听器）、`extension/manifest.json`（`minimum_chrome_version` 110、端口区间 host_permissions）。背景一节的 `core.js` 行号是改动前的状态，实现后已下移，故此处只引函数名。
- 单测：`web/tests/lib/report-target-pure.test.mjs`（候选口径 / 两条兜底 / 端口与窗口优先级 / 同 URL 幂等 / `path` 与 `url` 同尾）。
- 术语表：`docs/glossary-browser-extension.md`（本次新增「web 端标签页复用」「报告跳转目标解析」「扩展 → web 前端路由跳转」）。