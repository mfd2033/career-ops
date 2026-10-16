# ADR-0078: 详情页浮窗的面板级 Web 端入口（open-web）

## 状态

Accepted (2026-10-16)

## 背景

`职位评估` 扩展的详情页浮窗（ADR-0074，`extension/core.js` 的 PANEL_HTML / PANEL_CSS，视图逻辑在 `extension/detail-panel-pure.js`）提供四行读数（已评估 / 快评 / 状态 / 体检）与两个动作按钮（评估 / 快评）。行级 ↗（已评估行、体检行）的语义是「打开这一份报告」——评估报告走页内阅读弹窗（ADR-0074），体检报告走 ADR-0055 的复用跳转链。

用户诉求（Kaneo career-ops #47）：在浮窗里加一个**面板级**的 Web 端跳转入口——一键切到本地 career-ops 仪表盘（收件箱 `/pipeline`），不针对任何一份具体报告。日常使用中 web 端常年开着，用户在招聘站页面上想查管道全景时，目前只能手动切标签页或敲地址。

设计原型（`.scratch/career-ops-47-web-entry-prototype.html`，用户已确认）沉淀了三个共识：

1. **入口放标题栏**：面板级动作不侵占四行数据行的语义；标题栏在展开态与收起态下都常驻可见（`ce-collapsed` 只隐藏 `ce-body`），一处入口覆盖两种形态。**收起药丸不放入口**——药丸与标题栏在收起态下同时可见，放两处会出现两个 🌐。
2. **图标用 🌐**：行级 ↗ 已被「打开这份报告」占用，图形上必须区分；🌐 = 切去 Web 端，hover 底沿用报告链接的蓝色 `rgba(74,163,255,.16)` 词汇。emoji 不吃 `currentColor`，接受 Windows 彩色渲染；将来要单色再换 SVG，不阻塞本次。
3. **跳转目的地（2026-10-16 修订，用户确认原型后改向）**：主落点 = **当前职位的报告页** `/report/{n}`——报告号取自浮窗已评估行（`panelReportNum`，与徽章/行级链路同一来源），跳转编排直接委托 open-report 同一条链（评估报告支路）。这样三者的语义边界反而更清晰：行级 ↗ = 页内弹窗阅读，🌐 = 在 web 端整页看这份报告，体检行 ↗ = web 端体检页。未评估（无报告号）时兜底进 `/pipeline` 收件箱——面板级入口在任何状态下都得有去处。原方案「固定 /pipeline、不做上下文感知」被用户否决：日常场景里「去 web 端看这份报告」比「去收件箱」高频。

既有机制（ADR-0055 建立的本扩展 → web 跳转链）：

- `extension/report-target-pure.js`：web 端候选标签页识别（origin + 端口区间 3000-3040 粗判）、端口优先、「最近活跃」近似、同 URL 幂等、两条兜底（端口探测失败报错不跳 / 服务活着无候选新开）；
- `extension/background.js` 的 `open-report` 分支：解析目标 → 激活聚焦 → `navigateInWebTab`（`career-navigate` 消息请 web 端自己 `router.push`，1200ms 无 ack 回退整页导航）；
- `web/src/components/ext-nav-bridge.tsx`：页面侧监听 `__careerExt:nav`，**路由白名单 `^/report/[0-9]{1,6}$`**，不匹配不应答（SW 回退整页导航）。

约束：

1. 标题栏是唯一拖拽热区（`core.js` 的 pointerdown 处理器对 `.ce-toggle` 显式放行），新按钮必须同样放行，否则点 🌐 会顺手把面板拖走。
2. `pickReportTarget` 以报告号为中心（num 非法报「无效报告号」），`/pipeline` 没有报告号，不能硬塞 `kind` 参数进去。
3. 单测口径（ADR-0050 / ADR-0055）：浏览器里难以复现的判断抽 `*-pure.js`（严禁引用 chrome/window/document/location），单测落 `web/tests/lib/`；chrome 接线层手工验证。

## 决策

1. **PANEL_HTML 标题栏加一枚图标按钮**：`<button class="ce-web" title="在 Web 端打开这份职位报告" aria-label="在 Web 端打开职位报告">🌐</button>`，位置在 `.ce-title` 与 `.ce-toggle` 之间。样式复用 `.ce-toggle` 的 22px 规格做一条 `.ce-web` 规则（颜色/hover 用蓝色词汇），不与 `.ce-toggle` 共用选择器以便将来独立演化。药丸与 PANEL_HTML 其余部分零改动。
2. **拖拽热区放行**：`core.js` 的 pointerdown 守卫从 `e.target.closest(".ce-toggle")` 扩为 `e.target.closest(".ce-toggle, .ce-web")`。
3. **新消息类型 `open-web`**（content script → SW），不复用/不改 `open-report` 的消息契约：
   - content script 侧：`ce-web` 点击 → `chrome.runtime.sendMessage({ type: "open-web", num: panelReportNum || null })`，与 `openReport` 同款错误处理（SW 回 `ok:false` 时 toast 错误文案）；
   - SW 侧新分支：`num` 有效 → 委托 `resolveReportJump`（open-report 编排抽成的共用 helper，kind 固定 "report"）；无 `num` → `ensureLivePort()` 探测（失败 → 回 `WEB_SERVICE_ERROR`，但不跳转）→ 候选池解析落 `/pipeline`。
4. **纯函数层新增 `pickWebTarget({ livePort, tabs, currentWindowId })`**（`report-target-pure.js`）与配套 `pipelinePath()` / `pipelineUrl(port)`：
   - 候选筛选、端口优先、「最近活跃」近似规则**逐字复用** `pickReportTarget` 的同一段逻辑（两函数共用私有 helper `pickWebTab`，规则改动只改一处）；
   - 幂等粒度 = `urlKey(url)`（无 query），目标标签页已在 `/pipeline` 上 → 只聚焦，`navigate=false`；
   - 无候选 → `{action:"create", url, path}`；端口探测失败 → `{action:"error", error:WEB_SERVICE_ERROR}`——新增 Web 端专属文案「Web 端打不开：本地 web 服务可能未运行」，不复用 `NO_SERVICE_ERROR`（那条链路上没有「报告」可打不开，措辞照搬会误导），错误语义仍随 ADR-0055 决策 8。
   - 不扩展 `pickReportTarget`：它的 `num` 校验与 report/checkup 双落点分支是既有 17+ 条单测的契约，为第三落点改签名得不偿失。
5. **复用分支与 `open-report` 同 choreography**：先 `tabs.update(tabId,{active:true})` + `windows.update(focused)`，再 `navigateInWebTab(tabId, "/pipeline", url)` 前端路由优先、1200ms 无 ack 回退整页导航；不 `tabs.move`、不动招聘站标签页。
6. **web 端白名单扩一条，并抽成可测模块**：路径白名单本体移到 `web/src/lib/ext-nav-paths.mjs`（`isExtNavPath` = `^/report/[0-9]{1,6}$` ∪ `^/pipeline$`，无依赖、node 单测直接 import），`ext-nav-bridge.tsx` 只消费。「不匹配不应答」语义不变。`/pipeline` 不带参数、不可枚举，风险面与既有白名单同级。
7. **验证口径**：
   - `web/tests/lib/report-target-pure.test.mjs` 新增 `pickWebTarget` / `pipelinePath` / `pipelineUrl` 用例（候选口径、端口优先、幂等只聚焦、无候选 create、探测失败 error——与 ADR-0055 用例一一同构）；
   - 新增 `web/tests/lib/ext-nav-paths.test.mjs` 门住白名单的放行与拒绝两侧；
   - chrome 接线（消息往返、聚焦、前端路由、回退）按 ADR-0055 先例手工验证。
8. **术语表同步**：`docs/glossary-browser-extension.md` 新增「面板级 Web 端入口」词条（🌐 / open-web / 与行级 ↗ 的语义边界）。

## 后果

- 正面：浮窗任意形态下一键到收件箱；跳转链路（复用标签页、前端路由、双兜底）与 ADR-0055 完全同构，无新增跨层契约——`career-navigate` 通道只是多放行一条 path。
- 代价：`career-navigate` 白名单从「只进报告」放宽到「报告 + 收件箱」，web 端旧版停在白名单外时点击会多吃一次 800ms 等待再回退整页导航（功能不丢，与 ADR-0055 修订节的版本耦合代价同款）。
- 中性：emoji 图标在 Windows/Chrome 上是彩色渲染，不吃主题色；用户已确认接受。将来换 SVG 只动 PANEL_HTML 与一条 CSS 规则。

## References

- ADR-0055（复用 web 标签页 + `career-navigate` 通道 + 白名单语义的由来）、ADR-0074（浮窗结构与 PANEL_HTML/PANEL_CSS 的由来）、ADR-0050（纯函数 + node 单测口径）。
- `extension/core.js`（PANEL_HTML / PANEL_CSS / pointerdown 守卫 / `openReport` 错误处理口径）、`extension/report-target-pure.js`（新增 `pickWebTarget` / `pipelinePath` / `pipelineUrl`，共享候选解析 helper）、`extension/background.js`（`open-web` 分支）、`extension/web-bridge.js`（`career-navigate` 入口零改动）、`web/src/components/ext-nav-bridge.tsx`（白名单扩 `/pipeline`）。
- 单测：`web/tests/lib/report-target-pure.test.mjs`（新增 pickWebTarget 系列用例）、ext-nav-bridge 白名单断言。
- 设计原型：`.scratch/career-ops-47-web-entry-prototype.html`（用户已确认的最终形态）。
- 术语表：`docs/glossary-browser-extension.md`（新增「面板级 Web 端入口」）。
