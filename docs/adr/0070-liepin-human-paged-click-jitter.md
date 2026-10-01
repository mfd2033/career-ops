# ADR-0070: 猎聘扩展翻页驱动的仿人随机点击间隔

- **Status:** Accepted (2026-10-01)
- **Context:** 需求（2026-10-01 grill 会话，四轮问答全部锁定）：「用 bsk 扫描猎聘网站时，容易触发网站异常行为检测，增加仿人工点击的效果，比如增加随机延迟等」。现状与约束（均经代码核实）：
  1. **猎聘扫描有两条驱动**：①扩展驱动主路径（`extension/core.js` 的 `pagingAwareStep`，在真实登录浏览器里点「下一页」）；②服务端 bsk CLI 兜底（`bsk-extract.mjs` 导航 + 轮询读 DOM）。本次仅针对①。用户明确「触发路径 = 扩展翻页驱动」。
  2. **点击节奏是纯固定的**：扫描 tick `setInterval(scanTick, SCAN_SCROLL_INTERVAL_MS=900)`；分页路径每次 tick 调 `pagingAwareStep`，仅当 `Date.now() - scan.lastPageClickAt >= SCAN_PAGING_MIN_GAP_MS(1500)` 才点一次。点击只落在 900ms tick 边界 → 实际几乎精确每 ~1800ms 点一次，这种机械周期性正是行为检测的靶子。
  3. **猎聘是唯一分页型平台**：`grep isPageMode` 仅 `site-liepin.js` 为 true；`SCAN_PAGING_MIN_GAP_MS` 只在 `pagingAwareStep`（`isPageMode===true` 才走）中使用。改这个间隔**天然只影响猎聘**，BOSS/智联的滚动采集节奏不受任何影响。
  4. **验证码是「事后被动发现」而非「事前预防」**：狂点 → 猎聘跳验证页（URL 命中 `background.js::isAuthUrl` 的 `/verify|captcha|security|checkcode`）→ content script 随页面销毁 → 后台靠 ADR-0007 E10 存活探测把该驱动按结束处理，扫描静默死掉。本次诉求是**别走到那面墙**（预防层）；验证墙出现时的处置**维持现状**（用户选定「只做预防」，不新增暂停续采/自动退避）。
  5. **多目标并发**：`driveViaExtension` 为每个目标各开一个标签页并发采集（ADR-0066 下半屏平铺），猎聘拆词时多词=多标签。同步同节奏连点是强机器人特征，需首点错峰。
  6. **`scan-pure.js` 是可脱离 DOM 单测的纯逻辑层**（ADR-0007 E5/E7）：承载 `createScanAccumulator` 等；node 单测以 `module.exports` 守卫直接 import。随机间隔纯函数应放此处并锁默认值（符合仓库「默认值由纯模块导出并被单测锁定」惯例）。

- **Scope:** 扩展层两处（`extension/core.js` 分页点击调度 + `extension/scan-pure.js` 新增随机间隔纯函数与其单测）。**不动**：`bsk-extract.mjs` 兜底路径、`background.js` 存活探测/`isAuthUrl`、BOSS/智联滚动采集、扫描 tick 周期本身、采集门与 ADR-0069 进度链路、`SCAN_QUIET_MS`/`SCAN_BATCH_INTERVAL_MS` 语义。

## Decision

1. **机制 = 调度式细抖**：每次成功点「下一页」后，从 `Uniform[SCAN_PAGING_GAP_MIN_MS=1300, SCAN_PAGING_GAP_MAX_MS=2700]` 抽一个间隔 `nextGap`，用**独立的受管 `setTimeout` 排下一次点击**，而不是靠 900ms tick 边界门控。点击时序因此摆脱 tick 量化，得到真正平滑、不可预测的间隔。
   - 扫描 tick 保留，继续负责终止判定（`isDetailPath`/`reachedMax`/`quiet`）与「翻页后 URL 切换 → `pendingRescan` 全量重扫当前页卡片」的簿记；`pagingAwareStep` 不再自行决定点击时刻（点击改由调度定时器触发）。
2. **首点错峰**：进入分页扫描时不立即点下一页，先排一个随机初始延时的首点（与后续 `nextGap` 同一区间，或单列一个初始随机窗口），各标签独立抽取 → 并发标签自然错峰、不同步连点。
3. **速度目标 = 基本保速**：均值 ≈2000ms（现固定 realized ≈1800ms），慢约 10%。在 180s 前端轮询预算下约 90 页上限，猎聘 1200 条分页不受影响（已核算）。
4. **配置落点 = 硬编码合理默认值**：上下限常量放 `scan-pure.js`（默认区间被单测锁定）；`core.js` 引用。不新增配置页开关，不写 `config/profile.yml`。将来若需按平台/强度调节走新 ADR。
5. **纯函数边界（可测）**：`scan-pure.js` 新增 `pickPagingGap(rand = Math.random)` 与导出 `SCAN_PAGING_GAP_MIN_MS/SCAN_PAGING_GAP_MAX_MS`，`rand` 可注入以便确定性单测；`core.js` 只做调度与 DOM 点击，不含随机分布逻辑。
6. **生命周期与停点纪律**：新的点击定时器必须纳入 `timers`/`trackTimer`，在 `finishScan`/`teardown`、满上限、导航到详情页（`isDetailPath`）、无下一页控件、控件被禁用（`disabled`/`aria-disabled=true`）任一终态可靠清除并停点，杜绝停不下来的孤儿定时器。
7. **不影响既有兜底**：点击仍刷新 `scan.lastNewAt`、`pendingRescan=true`、`lastClickUrl=location.href`，让 `SCAN_QUIET_MS` 兜底、翻页重扫、URL 去重幂等语义完全照旧。

## Alternatives considered

- **tick 边界粗抖（仅把 `SCAN_PAGING_MIN_GAP_MS` 阈值随机化）**：改动最小，但被 900ms tick 量化吞掉，realized 只会出现 ~{1800,2700} 两档、均值 ≈2376ms（比现在慢约 30%），既不平滑也没保住速度。用户在第四轮明确否掉，选「换调度式细抖」。
- **连扫描 tick 周期一起随机化**：会同时影响 BOSS/智联的滚动步进节奏，越过「仅猎聘 / 仅点击间隔」边界，被否。
- **模拟鼠标移动轨迹/翻页前随机滚动/每页停留**：更拟人但复杂，且当前 `.click()` 不依赖坐标、收益存疑，超出「仅随机点击间隔」的深度选择，被否（lean-build：不过度构建）。
- **改 `bsk-extract.mjs`（兜底路径）加延迟**：用户触发的是扩展翻页路径，兜底路径本就少见且机制不同（导航+轮询非点击），不改。
- **验证码出现时暂停轮询、等人工过验证后自动续采**：需新增「验证页驻留 + 恢复」状态机，超出本次「只做预防」范围，被否（维持 ADR-0007 E10 现状）。

## Consequences

- **`pagingAwareStep` 职责收窄**：从「每 tick 判断并点击」改为「由调度定时器触发点击 + tick 仍做终止/重扫簿记」，点击时刻与 tick 解耦；需保证两条路径不重复点击（调度点击后置 `lastPageClickAt`，tick 不再自行点击）。
- **新增受管定时器**：每次翻页一个 `setTimeout`，务必随扫描实例 `scan` 生命周期登记与清理，避免并发多标签下串扰或停不下来；`lastPageClickAt` 已挂在 `scan` 上（非模块级），新定时器句柄同样挂 `scan`。
- **`scan-pure.js` 新增一处纯逻辑**：`pickPagingGap` + 默认区间常量，单测锁区间上下界与分布边界（min/max/注入 rand），并加源码守卫确认 `core.js` 经该纯函数取间隔而非散落魔数。
- **预防非万能**：调度细抖降低触发概率但不归零；真触发验证墙时行为与今天一致（驱动按结束处理、该扫描 partial）。若后续仍频繁触发，属新 ADR（错峰退避 / 验证页续采）。

## References

- ADR-0007（扩展驱动探索采集，E5 tick/批量上报、E7 上限、E10 存活探测/验证页静默死亡）——本 ADR 改动的宿主链路。
- ADR-0005（猎聘扩展适配、分页型 `isPageMode`、`findNextPageBtn`）——被随机化的翻页控件来源。
- ADR-0066（扫描下半屏多窗口平铺、单关键词门）——并发多标签 → 首点错峰的动因。
- ADR-0069（BSK 逐平台进度）——同宿主 `driveViaExtension` 链路，本 ADR 不动其进度信号。
- `extension/scan-pure.js`（纯逻辑 + `module.exports` 单测守卫）——`pickPagingGap` 落点与单测口径先例。
