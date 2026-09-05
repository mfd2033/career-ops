# Glossary — 浏览器全量采集（BOSS/猎聘/智联）

协同阅读：`docs/adr/0001-browser-full-collection-and-login-precheck.md`

## 采集相关

- **求职 profile（job-seeking profile）**：Playwright 通过 `launchPersistentContext` 使用的独立 Edge profile 目录，专供求职操作（扫描/跳转/申请），与日常 Edge 默认 profile 隔离。登录 cookie 存于此。
- **CDP trusted 滚轮**：Playwright `page.mouse.wheel()` 经 Chrome DevTools Protocol `Input.dispatchMouseEvent` 派发、浏览器层认可的原始滚轮事件。区别于 JS 设 `scrollTop`（浏览器不信任，无法触发懒加载）。
- **懒加载型平台**：需靠滚动到底触发加载更多列表的平台（BOSS、智联）。
- **分页型平台**：靠翻页控件加载下一页的平台（猎聘）。
- **multi-signal 登录探测**：组合多个页面信号（会话 cookie 存在性、用户区/头像 DOM presence、是否仍有「登录」按钮、统一兜底「无职位数据即视为未登录」）判定登录态；不依赖单一信号，避免误判。

## 会话相关

- **多端挤压（session eviction）**：同账号在不同浏览器/设备/登录态间，平台服务端只保留最新会话，后登录者把先登录者的会话挤下线。这是用户实测「日常 Edge 登录后 chrome 登录态被挤掉」的根因，也是登录预检成立的原因。
- **登录预检（login precheck）**：扫描前检测浏览器采集平台当前是否处于已登录态；未登录则引导补登后放行。仅覆盖浏览器采集平台，不触碰 ATS API 扫描。

## 平台

- **BSK**：browser-skill CLI，经扩展协议驱动用户已登录浏览器。用于 ATS 弱闭源站点导航等，但无 CDP 原生滚轮出口。
- **ATS 扫描**：Greenhouse/Lever/Ashby/Workday 等经官方 API 扫描，与浏览器方式相互独立。
- **BskListing**：浏览器采集器与上层之间的职位清单数据契约 `{ url, jobs: [{ title, url, city }] }`。