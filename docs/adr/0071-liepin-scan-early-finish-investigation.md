# ADR-0071: 猎聘扫描两三页后提前收尾 —— 诊断优先

- **Status:** Diagnosed (诊断于 2026-10-02 完成，成因坐实；修复另开工单)
- **Context:** 在 ADR-0070（猎聘翻页仿人随机间隔）的真机验收中发现：扩展猎聘 BSK 扫描打开搜索页、翻两三页后**自动关窗收尾**，采到的岗位只有几十条（≈两三页），远未到 1200 上限。已排除项（均经实测/读码）：
  1. **不是 ADR-0070 引入**：本次只改了翻页点击的调度（`doPageClick→scheduleNextPageClick→pickPagingGap`），**收尾三条件（`reachedMax` / 跳详情页 / 末页且静默 8s）逐字未动**。
  2. **不是反爬验证码墙**：本次扫描全程**无滑块/验证码**弹出，列表页正常渲染。
  3. **不是末页判定误触发**：用 bsk 在登录浏览器里打开猎聘第 2、第 6 页，复刻 `site-liepin.js` 的 `findNextPageBtn` 九条选择器——antd `li.ant-pagination-next` **每页都稳定命中、可见、未禁用**，42 张卡片都在。所以下一页控件并非在第 2 页后消失。
  4. **不是 `/api` 上报失败**：那是 `next dev` 下所有 `/api/*` 全 404 造成（已另立认知，见验收记录）；换打包 standalone 后 `/api/version`=200、上报正常，早停依旧。
- 未定论：早停真正原因未知，因为 `core.js` 的 `finishScan(reason)` 当前**不打日志**，后台按 ADR-0007 E10 探活把驱动按结束处理时也不落可观测的 reason。没有 reason 就无法区分下面三个假设：
  - **H1（主嫌）**：猎聘「下一页」点击触发**整页文档导航**（非纯 SPA pushState）→ content script 重载、模块级 `scan` 内存态与其定时器一起销毁、新实例 `scan=null` 不再采集 → 后台 E10 探活判定该驱动已结束 → 自动关窗。症状吻合"翻一页成功、后续静默终止"。
  - **H2**：`finishScan` 由某个终止条件被误触发（`isDetailPath` 误判 / `reachedMax` 因 maxCount 传入异常提前满足 / `quiet` 边界），reason 能直接指出是哪条。
  - **H3**：猎聘在后续页对驱动做了静默反爬（不发可见墙，但阻断点击/渲染）。

- **Scope（本 ADR 只做诊断，不改产品行为）：** 猎聘扫描的早停成因。修复（尤其 H1 的"跨导航保住扫描态"）在成因坐实后另开 ADR/工单，不在此预设。

## Decision

1. **诊断优先**：先加**最小、可移除**的观测，把早停的 `reason` 坐实，再据此开修复工单。拒绝在无证据时直接改 `findNextPageBtn`/静默阈值/调度参数。
2. **加两处临时诊断**（fork-local 脚本惯例，日志走 `console`，便于 bsk `console` 读回，验证完即撤）：
   - `core.js`：在 `finishScan(reason)` 入口 `console.log('[scan-end]', reason, {count, pagesTicks, location})`；并在 content script **启动/重新注入**处打一条 `[cs-boot] url=... hasScan=...`，用于验证 H1 的"导航导致重载、scan 归零"。
   - `background.js`：在 E10 探活把某驱动按结束处理时，`console.log('[drive-finalize]', scanId, why)`，标明是"主动 scan-done"还是"探活判死"。
3. **复现路径固定用打包 dashboard**（`/api` 正常），关键词量大（`Java` 全国），只勾猎聘，用 `bsk console` 抓 `[cs-boot]`/`[scan-end]`/`[drive-finalize]` 三类日志，判定：
   - 若每次翻页都伴随一条新的 `[cs-boot]` → H1 成立（整页导航销毁 content script）；
   - 若只有一条 `[scan-end]` 且 reason=`max`/`navigated`/`paged` → H2 定位到具体终止条件；
   - 若无任何 `scan-end`、只有 `[drive-finalize] … 探活判死` → 驱动静默死亡，指向 H1/H3，用 `bsk network` 看翻页是否整页文档请求 + 页面在停下的那一页实际渲染状态来二选一。
4. **产出**：一张"成因结论 + 修复方向"的回填记录（写回本 ADR 的「诊断结论」小节），修复另开工单。

## Alternatives considered

- **直接调大 `SCAN_QUIET_MS` / 放宽末页判定**：在无 reason 佐证下是碰运气，可能掩盖 H1，被否。
- **现在就重构 scan 使其跨导航持久化**：这是针对 H1 的修法，但 H1 尚未证实；先诊断再修，避免为猜错的成因付大重构。
- **纯靠人眼盯页面猜原因**：不可复现、不可证伪；换成结构化日志一次坐实。

## Consequences

- 诊断日志是临时的、面向单平台的 `console` 输出，验证完必须撤除，不得进产品长期行为；提交前用影子备份流程保护数据层（本改动不触数据层）。
- 若坐实 H1，修复面较大（扫描态需跨页存活或改为可恢复），需专门 ADR；ADR-0070 的抖动本身不受影响、保持已提交状态。

## References

- ADR-0070（猎聘翻页仿人随机间隔）——真机验收中发现本问题。
- ADR-0007（扩展驱动探索采集 E5/E7/E10）——扫描循环、终止条件、存活探测收尾链路。
- ADR-0005（猎聘扩展适配、`findNextPageBtn`、`isPageMode`）——被排除的末页判定来源。

## 诊断结论（工单 01 已坐实 · 2026-10-02）

**成因：早停是 `finishScan("max")` 命中了「每站采集上限」——扩展采集页本地配置 `scanMaxBySource.liepin` 实际被设为 `100`（不是 ADR 假设的 1200）。猎聘分页每页 ~42 条，采到 ~100 条（一个 tick 批量重扫会过冲至 126）即 `reachedMax` 为真→收尾→后台 settle→关窗。~100 ÷ ~42 ≈ 2–3 页，正好对上“翻两三页就自动收尾”。这是配置上限正常工作，非驱动缺陷。**

### 坐实方法（无扰诊断汇）

采集窗口“扫完即关”，实时 `bsk console` 抓取会被“借用/关闭”竞态污染（借用本身会扰动扫描），所以改用 **`localStorage` 持久汇**（liepin 域，跨标签页共享、跨关闭存活）：临时在 `core.js` 把 `start`/每翻一页 `paging`/`end{reason,count,scanTicks,pagesClicked}` 与 boot 计数镜像到 `__adr0071`。干净重跑一次（不碰采集窗口），事后从一个已加载的 `www.liepin.com` 标签读回。

一次干净 `Java`/全国/只猎聘 实扫读回（采集窗口自然运行 ~8s 后自关闭，全程未借用）：

```
boots: "1"   phase: "end"   reason: "max"   count: 126   pagesClicked: 2   scanTicks: 4   isPageMode: true
```

同时从扩展采集页同源 `localStorage['career-ops:config']` 读到：`scanMaxBySource: { zhipin:100, liepin:100, zhaopin:100 }`（`scanSource:["bsk"]`）——即本次驱动拿到的 `maxCount=100`。

### 三个假设的最终判定

- **H1（整页导航销毁采集态）—— 排除。** 干净实扫 `boots` 恒为 1（内容脚本未重注入）；与 bsk 手动逐页翻 window 标记跨页存活、`performance.now()` 不归零一致。猎聘翻页是纯 SPA `pushState`。
- **H3（后续页静默反爬）—— 排除。** 手动逐页翻至第 4+ 页，每页稳定 42 张新卡、下一页控件持续可见未禁用、无验证码/跳转。
- **H2（某个终止条件触发）—— 坐实，且具体条件是 `max`，不是之前推断的主嫌 `paged`。** 驱动合法地命中了配置上限 100 而收尾；`reachedMax = seen.size >= maxCount`（`extension/scan-pure.js`）是纯配置驱动，无任何提前误判。

> ✅ 纪律回顾：本 ADR 的 Alternatives 明确否决了“无 reason 就调 `findNextPageBtn`/静默阈值/调度参数”。实测证明这个判断是对的——驱动本身健康，基于代码路径的主嫌候选（`paged` 后台可见性门控）与真因（`max` 配置上限 100）完全不同。没有坐实就改驱动会错修。

### 修复方向（另开工单，非本诊断单）

1. **短期（配置，不改驱动代码）**：把探索页/配置页的 `scanMaxBySource.liepin` 从 100 抬到期望值（如 1200）即可采全。这是配置值问题，`findNextPageBtn`/静默阈值/调度参数均无需改动。
2. **产品面（可选另议）**：扫描上限对用户不够显眼，导致“命中上限”被当成 bug。可考虑在探索页结果区明示“本次采集受每站上限 N 约束，已采满/未采满”，避免误判。
3. **需核对**：当前 `scanSource` 为 `["bsk"]` 且三站上限均为 100，是否为用户有意设定（还是旧版残留）——由用户确认后决定是否回调默认。

临时诊断日志与 `localStorage` 汇（`core.js`/`background.js` 里的 `[diagnostic]` 段）已在本结论坐实后全部撤除，不进产品长期代码；实测期间对用户配置的临时改动（liepin 抬到 400）已恢复为原值 100，浏览器内的 `__adr0071` 诊断残留已清除。
