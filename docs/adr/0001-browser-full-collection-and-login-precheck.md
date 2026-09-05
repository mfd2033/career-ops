# ADR-0001：BOSS/猎聘/智联浏览器全量采集与扫描前登录预检

- 状态：提议（Proposed）
- 日期：2026-09-05
- 相关：web 探索页「扫描 tab」浏览器采集路径（原 bsk 驱动）

## 背景

探索页扫描 tab 用浏览器方式采集 BOSS直聘/猎聘/智联招聘三个中国招聘平台。原实现经 `bsk-extract.mjs --mode listing` 驱动用户日常浏览器，存在核心缺陷：

- **BSK 无 CDP 原生滚轮出口**，只会 JS `evaluate` 设 `scrollTop`。三家平台的懒加载/分页只认浏览器原始滚轮事件（trusted），程序设 scrollTop、`window.scrollTo`、trusted 按键翻页都不能触发加载，导致单关键词只能采到首屏约 17 条。
- `request-help` 人工介入会被平台反爬踢到 `about:blank`，无法借人工补采。
- 平台侧「全量」因此拿不到，用户要数据完整性。

实测证据（本会话诊断结论）：

| 通道 | 结果 |
|------|------|
| bsk `evaluate` scrollTop / `window.scrollTo` / `press End` | 17 条，恒定不涨 |
| Playwright `page.mouse.wheel`（CDP trusted 滚轮） | BOSS 同关键词、同 URL 拿到 127 条，懒加载正常触发 |

## 决策

### D1：采集器改用 Playwright 驱动系统 Edge（channel:msedge）+ 独立求职 profile

- 用 Playwright 管理系统 Edge：`channel:'msedge'` + `launchPersistentContext(独立 profile 目录)`。
- 系统 Edge 路径 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`；Playwright 自带 chromium `C:\Users\75186\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe` 作未登录态快采备用。
- 独立「求职 profile」与用户日常 Edge 默认 profile 隔离，不碰日常浏览。

### D2：按平台选采集策略

- **BOSS、智联**：懒加载型，`page.mouse.wheel()` 连续滚动到底触发加载，收全量职位链接。BOSS 未登录可采（实测 127 条），登录态更稳。
- **猎聘**：分页型，翻页采集。**必须登录态**（未登录 Playwright 返回空页，实测 job:0）。

### D3：独立 profile 登录态承载求职操作

- 该 profile 兼作「求职操作台」：扫描、管道跳转、职位申请都在其中。
- 首次一次性人工扫码登录三站，cookie 存 profile 持久复用。
- 管道跳转用同一 profile 打开职位 URL，登录态自动带上，可顺畅继续申请。

### D4：扫描前登录预检（multi-signal，非单头像）

- 前置检查仅限浏览器采集的三家平台；**ATS API 扫描与之相互独立，互不影响**（G6）。
- 登录判断 use 多信号 robust 探测（不止头像），候选：
  - BOSS：`$_zp_cookie_` 等会话 cookie 存在 + 右上角用户区 presence
  - 猎聘：`acw_tc` + 用户区 + 无「登录」按钮
  - 智联：token cookie + 用户区渲染
  - 统一兜底：探测页面拿不到任何职位数据也归为「未登录/需补登」
- 未登录处理：自动弹出该站 URL 的 profile Edge 窗口 → 用户扫码 → **自动检测到已登录自动关窗续扫**（G8/A）。

### D5：扫描前查，中途失效按平台失败处理

- 只在扫描前检查登录态（G9）。
- 扫描中途会话被挤掉线：该平台按失败处理，报 0 条 + 提示补登，不做中途实时兜底。

## 理由

- Playwright `page.mouse.wheel()` 走 CDP 原生 trusted 滚轮事件，是浏览器认可的真实输入，能触发懒加载（实测 127 vs 17）。这是 bsk 缺少、且无法在扩展协议层补齐的能力。
- 独立 profile 天然隔离日常登录与求职登录；避免「日常重登挤掉扫描登录」的相互污染（用户实测平台同账号多端单端挤压）。
- multi-signal 登录探测比单看头像稳，避免头像占位/懒加载导致的误判。
- 扫描前查 + 中途失败兜底，复杂度最低且行为可预期。

## 取舍 / 风险

- 首跑需一次性人工扫码三站（10 秒级），之后只增量补登被挤的站。
- 未登录态仍会被日常 Edge 使用平台时挤掉（同账号多端挤压），预检验证的是扫描时刻的登录有效性。
- 独立 profile 登录与日常 Edge 登录是两个并存会话，可能触发平台多端风控；可观察，必要时加间隔。

## 测试

- 采集器：asyn 单测 Playwright 驱动的 URL 构造、职位链接归一化（复用现有 `BskListing` 形状契约）；无法在单测环境跑真实滚动，做集成冒烟：无 head 的 msedge + 一次真实关键词采集 ≥ 17 条验证。
- 登录预检：纯函数单测 multi-signal 判定逻辑（各站信号组合 → 已登录/未登录/不确定）；平台探测脚本独立冒烟。
- 上层：`browser-scan.ts` 平台分发 seam 替换后 tsc + 现有测试全绿。

## Out of scope

- 猎聘未登录态采集（前置依赖登录，本 ADR 不实现）。
- 逆向平台 App/API 签名。
- 扫描中途实时登录兜底。