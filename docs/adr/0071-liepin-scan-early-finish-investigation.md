# ADR-0071: 猎聘扫描两三页后提前收尾 —— 诊断优先

- **Status:** Proposed (2026-10-01)
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

## 诊断结论（待工单 01 回填）

- 成因：_待复现日志确认_
- 修复方向与后续工单：_待补_
