# Glossary — BOSS直聘浏览器扩展（就地评估）

协同阅读：`docs/adr/0002-boss-zhipin-extension-inline-evaluation.md`

## 扩展本体

- **浏览器扩展（browser extension）**：Chrome Manifest V3 扩展，目录 `extension/`，`content_scripts` 仅匹配 `https://*.zhipin.com/*`。
- **content script**：注入 BOSS 页面的脚本，负责列表卡片复选框、详情页「评估」按钮、已评估徽章，并用 `MutationObserver` 跟随 SPA 动态列表。
- **background service worker**：扩展后台，负责端口探测、content script 与 web 之间的消息转发、发起评估、维护已评估集合。
- **popup（弹窗）**：扩展点图标弹出的面板，展示批量评估进度（解析 web 下发 NDJSON 流）。仅用于批量进度，「评估」本身始终在 BOSS 页面触发。

## 求职评估通道

- **`/api/batch-evaluate`**：web 端批量评估接口，`POST {urls, cliId, model}`，起真实 CLI 评估，流式返回 NDJSON，自动 reserve→merge→release。插件复用它承载全部评估。
- **NDJSON 流**：接口下发的逐事件 JSON 行（`status/text/item/done/error/keepalive`），popup 逐职位渲染进度用。
- **cliId / model**：config 页已存档的评估 CLS 与模型。插件经 web 读取当前配置并回填到评估请求，不重复配置。

## 已评估判定与报告

- **归一 URL（normalizeUrl）**：把职位 URL 降为稳定比较键（strip 跟踪参数等），作为「已评估」匹配 key。`web/src/lib/core/url-key.mjs` 是根 `url-key.mjs` 的镜像，必须 byte 对齐。
- **scoredUrls**：`pipelineSummary()` 内由 reports `**URL:**` header 构建的归一 URL→score 映射，判定「已评估」的现成数据源。
- **报告号（reportNum）**：tracker 应用行的 `n`，也是报告文件/报告页路由编号，跳转 `http://localhost:{port}/report/{num}` 用。
- **已评估映射（evaluated map）**：插件每次加载拉取的 `{归一URL → {score, reportNum}}` 集合；评估完成后主动刷新。

## 本地服务与安全

- **web 端口探测**：background 对 `localhost:3000-3040` 逐个 `GET /api/version` 找本地 web 服务端口（与 launcher `pickFreePort` 区间一致），命中缓存、失活重探。
- **origin-guard 放行口**：对 loopback + 固定扩展 ID 的 `chrome-extension://{id}` Origin 放行并回 CORS 头；其余跨站请求仍 403。扩展 ID 由 `manifest.json` 的 `key` 固定。
- **扩展 ID（extension id）**：MV3 由扩展 `key` 派生的稳定标识，后端据此识别可信来源。