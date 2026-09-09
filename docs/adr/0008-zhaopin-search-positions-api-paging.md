# ADR-0008：智联翻页采集直连 /c/i/search/positions API

- 状态：已采纳（Accepted）
- 日期：2026-09-09
- 相关：ADR-0006（智联扩展适配，其「positionList 顺序与 DOM 一致」假设已失效）、ADR-0007（扩展驱动探索页扫描，E4/E7）

## 背景

ADR-0007 上线后智联采集只稳定拿到首屏 20 条。用户登录态实测确认三层数据源失配：

1. **SSR 只渲染 20 条**：`www.zhaopin.com/jobs` 是 SSR 页，`__INITIAL_STATE__.positionList` 恒 20 条，滚动后不增长，且与 DOM 卡片顺序错位（`sameOrder:false`）→ index 映射失效。
2. **卡片 DOM 无职位锚**：卡片内唯一 `<a>` 指向公司详情，无 `data-*`、无 jobId → DOM 拼不出职位 url。
3. **页面自身 load-more 实测挂起**：反编译 chunk-common 确认机制存在——scroll 近底（距底 ≤ 2×innerHeight+900）→ `loadMoreJobList` action → `POST {fe-api}/c/i/search/positions`（pageIndex+1，登录守卫 `isSearchLoggedIn` = user.userId && cookies at/rt）→ 成功后 `appendPositionList` 追加。但实测该 XHR 发出后**静默挂起无响应**（风控疑似），`hasMore` 被置 false，列表停在 20。

关键突破：**同一 API 从页面上下文直接 fetch 稳定可用**。用 `__INITIAL_STATE__` 里的 queryParams(kw/jl)、cookiesData(at/rt)、statBaseData.actionid、resumeNumber、pageSize 镜像页面自身请求体（登录态 B 分支：`order:0` + `sortType:"DEFAULT"` + `anonymous:0`），`POST /c/i/search/positions` 返回 `{code:200, data:{count, list[20]}}`，item 含 `number/name/workCity/salary60/companyName` 全字段（实测 count=281）。

## 决策

智联采集改为**首屏卡片 + 翻页 API 直连**双通道：

### D1：background 新增 `zp-fetch-pages` relay

content script 发 `{type:"zp-fetch-pages"}` → background `chrome.scripting.executeScript({world:"MAIN"})` 注入异步循环：从 `__INITIAL_STATE__` 取参，pageIndex 2..25（安全上限 500，超 SCAN_MAX 由累积器截断），逐页 POST，350ms 节流；末页不满 / 已覆盖 count / 非 200 即停。回传精简 `{url,title,company,salary,city}[]`。

### D2：职位 URL 用 number 拼规范格式

`https://www.zhaopin.com/jobdetail/{number}.htm` — 与 SSR `positionList[].positionUrl` 同格式，去重键天然统一。不使用 API 返回的旧格式 `jobs.zhaopin.com/C{...}.htm`（ADR-0006 明确推迟跨格式归一，维持）。

### D3：core 双通道接线

- `site.fetchRestPages` 钩子：`startScan` 首屏卡片扫完后并行拉起，回传 meta[] **直喂累积器**（按归一 URL 与卡片路径去重）——不依赖 DOM 卡片增长，绕开页面内部状态。
- `pendingEnrich` 在途标志：抑制 quiet/no-scroll 终止条件（防翻页数据未回先收尾）；60s 看门狗防 relay 悬挂卡死扫描。
- `scanCollect` 对无 url 卡片直接跳过：原「ensureZpState 刷新重采」每次拉回同样 20 条，纯开销，已撤。

### D4：降级路径

MAIN world 取不到 kw/at/rt（未登录/非搜索页）→ 回传空数组 → 行为退化为首屏 20 条卡片采集（本篇之前的状态），不报错不阻塞。

## 理由

- API 直连绕开页面挂起的 load-more XHR 与 positionList 状态失配，数据完整性不再依赖 DOM 渲染。
- 请求体完全镜像页面自身请求（同 cookie、同参数口径），风控面上与真实用户翻页无差。
- 双通道按 URL 去重，首屏卡片（视觉真相）与 API 页（数据真相）互为冗余。

## 取舍 / 风险

- **接口是站方私有契约**：`order/sortType/anonymous` 等参数镜像自当前登录态 B 分支，站方改版可能失效 → D4 降级保底，采集数骤降回 20 即信号。
- **节流 350ms/页**：281 条 ≈ 14 页 ≈ 10s 内完成；更激进有风控风险，不做。
- **登录依赖**：at/rt 缺失即无翻页（站方本就如此设计 `isSearchLoggedIn` 守卫），非扩展引入的限制。

## 后果

- 智联单次采集上限从 20 提升至 min(count, 500, SCAN_MAX=400)。
- `scanCollect` 的无 url 分支语义从「刷新重试」变为「跳过（由 API 通道补）」，BOSS/猎聘无 url 卡片本就不存在，无回归。
- ADR-0006 的「positionList 顺序与 DOM 一致」结论作废，以本篇背景为准。
