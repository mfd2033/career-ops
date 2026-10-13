# ADR-0074: report-status 契约扩展（status + checkupStar）与详情页页内阅读弹窗

## 状态

Accepted (2026-10-13)

## 背景

详情页职位评估浮窗（把 `extension/core.js` 在职位详情页注入的「已评估徽章 / 快评徽章 / 评估本职位按钮 / 快评按钮」四个独立固定元素合并成一个可拖拽、可收起的浮窗）需要两样今天拿不到的信息，以及一条今天不存在的阅读路径。约束与既有事实：

1. **`/api/report-status` 的现有形状**是 `{ normalizeUrl(postingURL) → { score, reportNum } }`（`web/src/app/api/report-status/route.ts`，建端于 ADR-0002 决议「判定 key = normalizeUrl」；装配逻辑内联在路由里，无纯函数层）。同一个归一键命中多 tracker 行时**首个 app 胜出**——这是既有徽章的口径，浮窗若与它漂移就会自相矛盾。
2. **浮窗要显示投递状态**。规范状态集的真值是 `templates/states.yml`（9 个 label：`Evaluated / Applied / Responded / Interview / Offer / Rejected / Discarded / SKIP / Hired`）。中文标签已在 web 侧 i18n 有一份（`web/src/lib/i18n/clusters/pipeline.ts` 的 `pipeline.status.*` zh 段），但 content script 是纯 JS，**无法 import TS 模块**。
3. **浮窗要显示公司体检分数**。来源是 `data/company-checkups.tsv` 经 `checkupIndex`（`web/src/lib/company-checkups.mjs`）按 tracker# 聚合出的「最近日期那一次」`star`（1.0–5.0）。ADR-0064 已经明确这条数据的展示/排序边界：可为展示与排序所用，**绝不参与 filter / score / 任何门禁**。
4. **原计划的「点体检分数 → 复用已开 web 标签、不刷新跳转」做不到**。体检报告 HTML 由 `GET /api/checkup-report?n=<tracker#>` 这个 API 路由以原始 HTML 返回，不是 Next 页面路由；ADR-0055 修订引入的前端路由通道在页面侧有白名单 `^/report/[0-9]{1,6}$`（`web/src/components/ext-nav-bridge.tsx`），API 路径进不了白名单。剩下的唯一跳法是整页导航，而 ADR-0055 的修订节刚刚把「整页导航刷掉 web 端页面状态」判定为用户在真实使用中不接受的代价。
5. **评估报告正文没有任何端点可给**。`/report/{n}` 是 React 页面（报告正文渲染进 app shell，跟随 web 端深色主题、带站内导航与操作区），`/api/report/shape` 只做结构性诊断，两者都拿不到可再加工的正文。
6. **招聘站页面是 https**，页面内 `iframe src` 或 `fetch` 指向 `http://localhost:{port}` 属混合内容，会被浏览器拦。扩展的 `host_permissions` 已含 `http://localhost/*` 与 `http://127.0.0.1/*`，background service worker 里发请求不受该限制。
7. **报告与体检 HTML 都是生成内容**，按 AGENTS.md 的未信任外部内容纪律只当数据读，不当指令执行。
8. **房规（ADR-0050）**：难以在真实浏览器里稳定复现的判断抽成 `*-pure.js`（不引用 `chrome` / `window` / `document` / `location`，`self` + `module.exports` 双导出），单测落 `web/tests/lib/*.test.mjs`，由 `node --test` / `test-all.mjs` 门住。

原型见 `.scratch/prototype-detail-panel/`（浮窗 + 阅读弹窗，视觉与交互已由用户定稿；一次性产物，不纳入提交）。

## 决策

### 一、契约扩展（`/api/report-status`）

1. **扩展现有接口，不新增端点**：在 `{ score, reportNum }` 上按同一个 `normalizeUrl` 键追加 `status`（tracker 行的**原始规范状态值**，如 `Applied`）与 `checkupStar`（该 tracker# 在体检台账里最近一次的 star，`number | null`）。一次请求让扩展拿全四行读数，与既有「已评估」徽章同源。
2. **不变量·语言不进接口**：`status` 永远返回原始规范值，接口不返回中文标签。中文映射只在前端做——web 在 TS i18n、扩展在浮窗纯模块。content script 无法 import TS，因此扩展侧那份是**有意的双份字典**，不是待合并的重复；两份都以 `templates/states.yml` 的规范状态集为唯一真值对齐，各自被自己的测试锁住（web 侧 i18n 测试、扩展侧纯模块单测逐状态断言）。未知原始值回退中性色「已评估」，原值透出在 `title` 里，不静默丢弃。
3. **不变量·checkupStar 不入决策**：仅供浮窗展示与次要出口跳转，绝不回流评分、过滤、批量动作资格或任何门禁（延续 ADR-0064 的口径，本次不新开口子）。
4. **首个 app 胜出规则不变**，新增两字段与既有 `score` / `reportNum` 取自同一行，保证四行读数永不互相矛盾。
5. **装配抽成纯函数**（接缝 A）：`web/src/lib/report-status-map.mjs`，路由只做序列化。map 的形状、新字段、缺省值、多行胜出全部由 node 单测锁住——按房规「路由层不测，测它调用的纯函数」。

### 二、详情页阅读改走页内弹窗

6. **不变量·详情页读报告走页内弹窗，不经 ADR-0055 跳转链路**：浮窗「已评估」「体检」两行行尾 ↗ 在招聘站页内弹出居中遮罩大 modal 直接读完，不切标签页。同一个手势顺带覆盖「评估完成自动看报告」：`finalizeDetail` 在详情页浮窗在场时改为就地弹窗（列表页右栏发起的评估没有弹窗载体，仍按 ADR-0055 跳转并按实际落点写 toast 文案）。**范围只限详情页**——列表页卡片徽章的 `open-report` 行为原样保留（仍走 ADR-0055），本次不动。
7. **新增只读端点 `GET /api/report-source?n=<报告号>`**，返回报告 markdown 原文（`text/markdown`）。正文经既有 `readReport(n)` → `findReportFile(n)`，因此自动继承它的两条守卫：tracker 行报告链接为准 + `containedRealpath` 包含校验 + `{n}-RESERVED.md` 哨兵跳过。该端点只读、不写、不改状态。
8. **markdown→HTML 渲染放扩展侧纯模块**（`extension/detail-panel-pure.js`，接缝 E：`mdToHtml(text) → { html, toc }`，纯字符串进出），web 端不新增任何 markdown 依赖。渲染纪律：**先把整篇转义，再上标记**——不注入原始 HTML，不接受报告正文里的脚本或事件属性。
9. **正文用浅色阅读版式，不跟随 web 端深色主题**；只有弹窗标题栏沿用浮窗的深色 chrome 保持同源感。理由：弹窗开在招聘站页面上，那里本来就是浅色内容环境；跟随 web 深色主题会让同一段文字在两个上下文里换一套对比度，且要为扩展侧复制一整套 web 主题变量。
10. **取内容一律经 background service worker 代发 `fetch`**，content script 只拿回文本再注入 DOM——绕开 https 页内拉 `http://localhost` 的混合内容拦截（决策背景 6）。本地服务未起时回可展示的错误文案，沿用 `report-target-pure.js` 既有的 `NO_SERVICE_ERROR` 口径，不静默失败。
11. **安全边界**：体检 HTML 是 API 直出的自包含 HTML，进 `iframe srcdoc` + `sandbox=""`（无脚本、不透明源、禁表单）；评估报告走决策 8 的转义渲染。两者都按未信任生成内容处理（背景 7），弹窗不提供任何写操作。
12. **排版细节（原型定稿）**：评估报告右侧目录抽 `h2`/`h3`，**默认展开**、标题栏「☰ 目录」一键收起/恢复，点条目在正文内滚动定位并高亮当前节；`Machine Summary` 的 yaml/json 围栏渲染成 `<details open>`（默认展开）；弹窗尺寸 `min(1120px, 80vw) × min(880px, 85vh)`。
13. **次要出口保留**：标题栏「↗ 在 web 端打开」复用 ADR-0055 的落点解析（接缝 D）——评估报告目标 `/report/{n}`，体检目标 `/api/checkup-report?n=<tracker#>`（后者落在整页导航分支，因为 API 路径进不了前端路由白名单；这是**次要出口**，不承担「不刷新」承诺）。弹窗是主路径，web 页仍是完整操作面（站内导航、PDF、改状态、重跑体检）。
14. **刷新时机不变**：页面加载 + `evaluated-updated` 消息，**不新增轮询**。`status` / `checkupStar` 随同一份 evaluated map 流入，因此与分数徽章同源同频；体检由无头 worker 异步完成，完成值在下次进入详情页时才反映，属已知可接受。

## 被拒方案

- **新增独立 `GET /api/posting-context?url=` 端点**：多一次往返、多一套 key 口径，且与既有徽章变成两个数据源，同一职位可能出现分数说「已评估」、状态说「已申请」的漂移。
- **接口直接返回中文标签**：把语言写死进跨端契约，web 侧换语言包要连着改接口，扩展侧展示语言被服务端绑架。
- **`/checkup/[n]` 新页面路由**：能进 ADR-0055 的白名单、做到「不刷新跳转」，但为此要在 web 端新增一个页面壳去 iframe 或 proxy 一份 API 已有的 HTML，而弹窗方案本来就要读同一份 HTML——多出的页面路由不换来任何新能力。
- **永远新开标签页 / 复用标签整页导航**：前者把用户从招聘站上下文里拽走（正是本任务要消除的痛点）；后者会刷掉 web 标签页当前状态，是 ADR-0055 修订节刚被用户判定不接受的代价。
- **markdown 在 web 侧渲染成 HTML 再喂弹窗**：web 要新增 markdown 依赖（当前零依赖），且体检 HTML 那边仍然绕不开同一个「API 原始 HTML 进不了路由」的问题——两套内容两种取法，不如统一成「扩展拿正文、自己排版」。
- **在弹窗里放报告页的全部操作（改状态、生成 PDF、重跑评估）**：把详情页浮窗变成第二套 web UI，跨端契约面急剧扩大；本次弹窗严格只读。

## 后果

- 正面：一次 `readEvaluated()` 拿全四行读数，浮窗内不再有第二个数据源；读报告不再切标签页；web 端不新增 markdown 依赖；`status` / `checkupStar` 的缺值走浮窗统一的占位符规则，行结构不跳动。
- 代价一（跨端契约面扩大）：`/api/report-status` 从两端各管各的变成一份共享契约，改动需 web 与扩展同步发布；旧扩展读新接口不受影响（只是不认新字段），新扩展读旧接口时 `status` / `checkupStar` 为 `undefined` → 走占位符分支，不会报错。
- 代价二（双份字典会漂移）：`states.yml` 加新状态时，web i18n 与扩展字典两处都要改，漏一侧的表现是该状态在扩展侧回退成中性「已评估」+ `title` 里的原值——可发现、不撒谎，但没有单一事实源那么牢固。刻意接受，并在单测里逐状态断言兜住。
- 代价三（多一个只读端点）：`/api/report-source` 把报告正文暴露到 loopback HTTP 面上。边界与既有 `/report/{n}` 页面一致（同源数据、同样的包含校验与 RESERVED 跳过、origin-guard 仍只管扩展放行），不新增可写面。
- 代价四（弹窗排版是自研子集）：`mdToHtml` 只覆盖报告实际用到的标记（标题/表格/列表/围栏/引用/键值行），不是通用 markdown 引擎。报告格式演化出新区块语法时需同步渲染器，由接缝 E 的单测先红。
- 已知局限（不绕）：`sandbox=""` 的 iframe 是嵌套浏览上下文，弹窗的焦点陷阱管不到它内部的 Tab，无脚本沙箱也无法反向接管——浏览器标准行为。
- 回滚：契约两个新字段是纯追加，路由与 map 单点可退；`/api/report-source` 单文件可删；弹窗与浮窗是 `core.js` 详情页注入层的改动，列表页徽章未受影响，可独立退回跳转方案而不影响契约扩展。

## References

- 建端与被扩展的既有契约：`docs/adr/0002-boss-zhipin-extension-inline-evaluation.md`（`/api/report-status` 的由来与 `normalizeUrl` 判定 key）、`docs/adr/0005`/`0006`（猎聘/智联清单同步时「key 两端必须一致，否则已评估判定漂移」的同一条约束）、`docs/adr/0018-worker-report-jump.md`、`docs/adr/0051-extension-single-eval-via-run.md`（`finalizeDetail` 依赖 evaluated map 的口径）。
- 阅读路径改道的对象：`docs/adr/0055-report-jump-reuses-open-web-tab.md`（含 2026-09-23 修订——白名单只认 `/report/{数字}`、整页导航的刷新代价已被判定不接受；本次它的详情页分支降为次要出口，列表页分支不变）。
- 展示 vs 决策的边界：`docs/adr/0064-checkup-score-column-sort.md`（checkupStar 可展示可排序、不入 filter/score/门禁）、`docs/adr/0025-offer-checkup-skill-integration.md`（体检台账本体）。
- 纯模块 + node 单测房规：`docs/adr/0050-toolbar-connection-status-badge.md`；实现落点 `web/src/lib/report-status-map.mjs`、`extension/detail-panel-pure.js`、`extension/report-target-pure.js`、`extension/core.js`、`extension/background.js`、`extension/manifest.json`、`web/src/app/api/report-source/route.ts`。
- 术语：`docs/glossary-browser-extension.md`（新增「职位浮窗」「页内阅读弹窗」「次要出口」）、`GLOSSARY.md`（新增「体检分数」「投递状态」）。
- 原型：`.scratch/prototype-detail-panel/`（浮窗 + 弹窗视觉与交互定稿，一次性产物，不入提交）。
