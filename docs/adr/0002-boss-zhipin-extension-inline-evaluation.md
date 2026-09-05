# ADR-0002：BOSS直聘页面浏览器扩展——就地评估与报告跳转

- 状态：提议（Proposed）
- 日期：2026-09-05
- 相关：web dashboard（launcher 承载）、`/api/batch-evaluate`、浏览器采集（ADR-0001）、`origin-guard.mjs`

## 背景

用户日常把 BOSS直聘 当招聘主战场，浏览职位卡片时想做两个动作：就地评估（打分/出报告）与回看已评估结果。因此需要一个浏览器扩展，侵入 BOSS 页面提供三件事：

1. **触发评估**——对单个/批量职位发起评估；
2. **已评估标识**——已评估职位在 BOSS 页面上可见标记；
3. **报告跳转**——点标识能回到 web 端该职位对应的报告页。

与用户对齐后的场景语义（本 ADR 的契约）：

- **非自动评估**：用户**手动点击**才触发，不做边浏览边自动评估。
- **批量范围**：BOSS 搜索列表页支持勾选多个职位一次批量评估。
- **CLI/模型**：复用 config 页已存档的评估 CLI+模型，插件不重复配置。
- **报告落点**：点已评估标识 → 新 tab 打开 web 报告页（`/report/{num}`）。
- **进度展示**：批量评估进度在插件弹窗内流式展示。

### 既有可复用资产（非新建）

| 资产 | 位置 | 作用 |
|------|------|------|
| `/api/batch-evaluate` | `web/src/app/api/batch-evaluate/route.ts` | POST `{urls, cliId, model}`，起真实 CLI 批量评估，流式 NDJSON，自动 reserve 报告号→merge→release |
| `pipelineSummary().scoredUrls` | `web/src/lib/career-ops.ts` | 由 reports `**URL:**` header 构建的归一 URL → score 映射，是「已评估」判定现成数据源 |
| `normalizeUrl` | `web/src/lib/core/url-key.mjs`（镜像根 `url-key.mjs`，byte 对齐约束） | 职位 URL 归一化为稳定 key，作已评估匹配键 |
| launcher 端口自选 | `dashboard-ui/launcher.go` `pickFreePort()` | 端口在 3000-3040 动态选定 |

### 关键硬约束

- **origin-guard 阻断跨站**：`web/src/lib/origin-guard.mjs` 拒绝 `Sec-Fetch-Site: cross-site` / Origin 不匹配 Host 的 `/api` 请求。插件在 `zhipin.com` 页面发起的跨站请求默认 403，必须先开一道受控放行口。
- **端口动态**：web 服务端口 3000-3040 由 launcher 启动时选定，无法硬编码进扩展。
- **评估是 LLM 长任务**：每个职位几十秒；批量必须与 web 共用同一评估引擎与 config，禁止插件复制评估逻辑。

## 决策

### D1：Chrome Manifest V3 扩展，content script 注入 BOSS 页面

扩展目录 `extension/`（项目根）。`content_scripts.matches` 仅 `https://*.zhipin.com/*`。content script 负责：列表页注入复选框、详情页注入「评估」按钮、为已评估卡片注入徽章。BOSS 是 SPA 动态渲染，用 `MutationObserver` 跟踪列表节点变化。

### D2：评估通道直连 localhost web `/api/batch-evaluate`（非 native messaging）

插件把选中的职位 URL 交给 web 端既有 `/api/batch-evaluate` 评估，完全复用现有引擎、报告号分配、tracker 合并与 config（cliId/model）。

- **放弃 native messaging**：需另装宿主程序跑 node CLI，与 launcher 双机制并存，部署成本高。
- **放弃「插件只收 URL 交 web 手动评估」**：评估不即时，违背就地评估场景。

### D3：端口自动探测

插件 background service worker 对 `localhost:3000-3040` 逐个 `GET /api/version`，命中即得 web 端口。与 launcher `pickFreePort()` 区间一致，零用户配置。命中后缓存端口，失活时重新探测。

### D4：后端放行策略——绑定固定扩展 ID

`origin-guard.mjs`/`middleware.ts` 增加一条：**Host 为 loopback 且 Origin 等于绑定扩展 ID 的 `chrome-extension://{id}`** 时放行（`Sec-Fetch-Site` 为 cross-site 的阻断前置不变），并对该 origin 返回 `Access-Control-Allow-Origin`。

- 扩展 ID 由 `manifest.json` 的 `key` 字段固定（开发用 pem 定义，生产注入稳定 key），使 ID 稳定可绑。
- **放弃**放行任意 `chrome-extension://` 源：那会把本机 `batch-evaluate`（远程执行原语）暴露给任何已装插件。

### D5：已评估判定 key + 数据源

- 判定 key = `normalizeUrl(职位URL)`（`url-key.mjs` 镜像，需与核心保持 byte 对齐）。
- 数据源 = `pipelineSummary().scoredUrls`（归一 URL → score）+ tracker 行 `n`（报告号）。新增一个 web 查询接口 `GET /api/report-status` 返回 `{ url: { score, reportNum } }`，复用 `buildScoreByUrl` 派生（score 已现成，reportNum 从应用行 `n` 取）。
- 插件加载时拉取一次该映射，本地建 `Set(normalizeUrl)` 判断徽章。

### D6：列表页批量 + 详情页单职位双入口

- 列表卡片：勾选框，多处选中后 popup 内「评估所选 N」。
- 详情页：单个「评估本职位」按钮。
- 判重由 web 端 batch-evaluate/tracker 合并承担，插件只负责正确传 URL。

### D7：评估中交互与进度

- 评估进行中相关按钮禁用/徽章「评估中」。
- popup 内解析 `/api/batch-evaluate` 的 NDJSON 流，逐职位显示 待评估/进行中/完成（含评分）/失败。评估完成后重新拉取已评估映射，刷新徽章。

### D8：报告跳转

点已评估徽章/已评估条目 → `chrome.tabs.create({ url: 'http://localhost:{port}/report/{reportNum}' })` 新 tab 打开 web 报告页。

## 理由

- **复用 `/api/batch-evaluate`**：评估引擎、报告号分配、tracker 合并、config 全部单一来源，插件零重复逻辑，行为与 web 管道页完全一致。
- **绑定固定扩展 ID 放行**：把 origin-guard 的安全边界只向本扩展扩一毫米，其余跨站请求依旧 403。
- **自动探测端口**：零配置，与 launcher 端口策略天然耦合，避免端口漂移。
- **normalizeUrl + scoredUrls**：与探索页/管道页共享同一去重与已评估语义，避免「已评估却标未评」的判定漂移。

## 取舍 / 风险

- **扩展 ID 固定依赖 pem/key**：MV3 扩展 ID 由 `key` 派生；未固定的开发构建 ID 会变。需在开发期即用固定 key，否则后端绑定失效。
- **批量并发上限**：`/api/batch-evaluate` 内 `MAX_PARALLEL=3`，交大量职位时按池排队，是既有行为，插件不重实现。
- **CSRF/投毒面窄化但需守稳**：放行口只接受 loopback + 固定扩展 origin；`Sec-Fetch-Site: none`（扩展后台对方导航）路径按现有逻辑视为可放行，需单测确认不放宽到任意 origin。
- **BOSS SPA 结构易变**：content script 的选择器与 MutationObserver 需随平台改版维护。
- **已评估集合为快照**：插件加载时拉取的映射在评估后需主动刷新，不做实时推送。

## 测试

- **unit**：`normalizeUrl` 匹配、端口探测、已评估判定（`scoredUrls` key 命中）、`/api/report-status` 序列化；`origin-guard.mjs` 扩展放行判定（绑定 ID 放行 / 陌生 ID 拒 / 任意 extension 拒 / 非 loopback 拒）。
- **integration 冒烟**（Playwright）：加载扩展 → 打开 BOSS 列表页 → 勾选 2+ 职位 → 发起批量评估 → popup 可见逐条进度 → 完成后卡片出现已评估徽章 → 点徽章新 tab 打开 `/report/{num}`。
- **回归**：web 侧 tsc + 既有测试全绿；`url-key` parity 测试不破。

## Out of scope

- 非 zhipin 平台（猎聘/智联）的扩展侵入；插件仅覆盖 BOSS 直聘页面。
- 自动评估 / 浏览即评估。
- 插件内评估逻辑重写（评估统一走 web `/api/batch-evaluate`）。
- 移动端 / 非 Chromium 浏览器。