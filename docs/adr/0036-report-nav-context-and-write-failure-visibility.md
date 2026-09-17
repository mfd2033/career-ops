# ADR-0036: 报告详情页的导航上下文与状态写入失败的可见性

- **Status:** Accepted (2026-09-17)
- **Context:** 2026-09-17 报「管道页面，修改报告状态后，点击上一个/下一个，状态下拉框显示的值不对」。用三个可在运行版（:3000）上复跑的回路（`web/tests/debug/`，零数据写入）定位出两条互相独立的成因：

  1. **详情页的导航上下文在"当前行离开该视图"时静默回退全表。** `pipeline/[id]/page.tsx` 用 URL 里的 `tab/min/sort/q` 复原列表页的有序视图，再用 `index = ordered.findIndex(a => a.n === id)` 定位当前行；`index === -1` 时回退 `DEFAULT_ORDER`（tab=ALL 全表）。但**在状态筛选标签里改状态，必然让该行离开标签**——写成功后 `StatusSelect` 调 `router.refresh()`，服务端按原 `tab` 重算时该行不再匹配，于是回退全表：prev/next 变成全表邻居、位置分母从 `/68` 变 `/676`、链接带上 `?tab=ALL`。实测对照：行仍在标签内 `/pipeline/11?tab=DISCARDED` → `35 / 68`、下一个 `?tab=DISCARDED`；改完之后 `/pipeline/103?tab=DISCARDED` → `149 / 676`、下一个落到全表邻居 `#102`（下拉显示 `Rejected`），而用户当时在走"已放弃"队列。用户当天账本（本地、未入库的 `data/status-log.tsv`）最后一次写入正是一次 `Evaluated → Discarded`，与本次报障同一小时——这条是"机制被真实触发过"的证据，具体行号与时间戳留在本地账本里，不进仓库。
  2. **tracker 里存在重复行号（数据损伤）。** `data/applications.md` 有 15 组重复（`merge-tracker` #1704 的遗留），其中 `#432` 是**同一行号出现两次**。两条后果都实测复现：(a) `/api/status` 委派 `set-status.mjs --row 432` 命中 `ambiguous`（exit 3 → HTTP 409），`StatusSelect` 的 `catch` **静默回滚**——下拉框会把用户刚选的值吞掉且不提示任何原因；(b) `findIndex(a => a.n === id)` 永远命中第一份，而 `ordered` 里有两份，于是"第二份的前一行"的**下一个链接指回同一 id**：位置 153 回跳 137，`137…153` 成闭环（`155+` 用"下一个"永远走不到），`position/total` 也随之差 1（676 vs 675）。
  3. 2026-09-17 已用官方 `dedup-tracker.mjs` 修复数据（15 组，备份 `data/applications.md.bak`）：661 行、无重复 id、`--row 432` 由 exit 3 变 exit 0、"下一个"恢复逐条前进（回路复跑 GREEN）。**数据修的是损伤，不是机制**：只要写入链再产生重复行号，或用户在标签里改状态，症状就会回来——所以本 ADR 管机制。
  4. **已证伪、禁止再按它改的猜测**：`StatusSelect` 只有 `useState(current)` 且挂载处无 `key`，于是跨报告残留状态。dev server + 打桩 POST 的判别实验显示：在 A 设的值**不会**泄漏到下一个报告（路由参数变化会重挂载），普通相邻对（#616→#124）下拉显示正确。按它加 `key`/`useEffect` 只会掩盖真因。

- **Scope:** web 层三处——详情页的 prev/next 计算、状态下拉框的失败呈现、导航序列的去重语义；并把导航计算下沉为可单测的纯函数。**不动**：tracker 的 schema 与写入语义、`set-status.mjs` 的 CLI 契约（exit code 与 `--json` 的 `code` 已足以表达原因）、列表页的筛选/排序语义、状态标签的筛选语义。

## Decision

1. **导航序列抽成纯函数 `navNeighbors(rows, ctx, id)`，与 `orderApplications`/`buildContextQuery` 同址**（`web/src/lib/pipeline-order.mjs`，已被 `web/tests/lib/pipeline-order.test.mjs` 那份 `node --test` 锁定）。返回 `{ prev, next, position, total, context }`：`context` 是**实际生效**的上下文，页面据此拼 `contextQuery`；参数解析与 `notFound()` 仍留在页面。详情页不再自己写 `findIndex`/回退分支。

2. **行离开当前视图时不再回退全表。** 若该 id 在 tracker 中存在、只是不匹配 `ctx`（标签 / 最低分 / 搜索词），就**留在 `ctx` 内**：用与 `orderApplications` 相同的排序比较器算出它"离开前"的插入位置，prev/next 取该位置的邻居，`position` 显示插入位置（从尾部离开的钳到列表长度——否则会出现 `68 / 68` 之外的 "69 / 68"，而它的 `下一个` 本来就是 null），`total` 为该 `ctx` 列表长度。只有在**算不出插入位置**时才保留现状语义：`tab === "INBOX"`（triage 队列本就不是 tracker 表，无行可导航）、该视图当前为空（没有可插的槽）、或该 id 在 tracker 中根本不存在（`app` 为 null，导航本就不渲染）。

3. **导航序列按 id 去重。** `navNeighbors` 内部对同一 `n` 只保留第一条，`position`/`total` 基于去重后的序列。理由：导航的语义单位是"报告行"；同 id 的多行是数据损伤，不应制造自指链接与闭环——去重让"下一个"在任何数据状态下都严格前进一格。

4. **写入失败必须可见，不允许静默回滚。** `StatusSelect` 在非 2xx 时回滚本地值**并显示原因**，且不再假设写入成功（也不调 `router.refresh()`——什么都没写，刷新只会重渲染同一行）；成功路径不变（乐观更新 + 已保存 + refresh）。**分岔以 CLI 的 `code` 优先，只有完全没有 `code` 时才退回看 HTTP 状态**——`/api/status` 会把多种失败都映射成 503（data-only root 的 `core-script-missing` 也是 503），只看状态会把"缺脚本"误报成"tracker 被占用"，给出错误的下一步。分支集合：`ambiguous` → 该行号在 tracker 里重复 + 修复动作（`node dedup-tracker.mjs`）；`not-found` → 行已不在 tracker，刷新而不是重试；`lock-timeout`（含无 code 的 503）→ tracker 被占用，稍后重试；**504 → 结果未知**（路由原文是 may or may not have been applied，文案不得宣称"没写成"，否则用户会去重试一次可能已落盘的写入）；fetch 抛错 → 本地服务不可达；其余（含 500、以及不认识但确实存在的 `code`）→ 显示服务端 `error`（单行、截断到 160 字符）或 `HTTP <status>`。**文案映射抽成纯函数**（`web/src/lib/status-write-error.mjs`，返回 i18n key 而非成稿文案，两种语言都在 `clusters/pipeline.ts` 里）并由 `node --test` 锁定——本仓没有 jsdom/React 测试基建，把可测部分下沉是唯一有意义的回归 seam。

5. **不隐藏、也不"智能消歧"重复行号。** (a) 列表页不为重复行号做折叠/隐藏（隐藏数据损伤会让"为什么少了行"无从解释），本 ADR 也不做可见标记（数据已修；若重复再现，优先修根因）；(b) API 层不为调用方猜行（不自动取第一行、不代传 `--role`）——`set-status` 的 `ambiguous` 守卫正是为"别静默写错行"而存在，本 ADR 只把这次拒绝**呈现**给用户。

## Alternatives considered

- **保持回退全表 + 加一条提示横幅**：仍然把用户踢出正在走的队列，提示只是事后补偿；且横幅要新增状态位，成本高于修上下文本身。
- **改 `router.refresh()` 的时机（或不刷新）**：会让同一 tracker 的其它行/分数不再新鲜（worker 并发写同一文件），等于把"上下文错"换成"数据旧"。
- **给 `StatusSelect` 加 `key={id}` 或 `useEffect` 同步 props**：已证伪（见 Context 4），改了只是掩盖。
- **`--row` 命中重复时自动消歧（取第一行 / 代传 `--role`）**：等于替用户猜要改哪一行，静默写错行的代价远大于一次可见的失败。
- **导航计数沿用原始行数（不去重）**：会保留"分母含一条不可导航的重复行"的错位，正是 676 vs 675 那类困惑。

## Consequences

- 详情页的 prev/next 与"用户正在看的那个列表"始终一致：在标签里改完状态后能继续沿队列走；位置指示显示该行**离开前**的位置（本 ADR 不加横幅提示——位置与上下文已表达；若日后需要，另开）。
- 写入失败第一次变得可解释：409 的提示直接把修复动作写出来，用户不必再靠猜。
- `navNeighbors` 成为导航语义的唯一实现，页面只做解析与拼 query；回归测试落在既有的纯 `node --test` 套件里，不需要浏览器或 dev server。
- 已知取舍：列表页行数（原始）与导航计数（去重后）在数据再次出现重复行号时会不一致（例如列表 662 行、导航 `x / 661`）。这是刻意的：导航计数只数可导航的报告行，如实反映"下一个还能走几格"。
- 三处修复都不触碰 CLI 契约、tracker 语义与列表页筛选语义，系统层更新可安全覆盖。
- 验证脚本收口在 `web/tests/debug/`（都带 `[DEBUG-a4f2]` 头、都零写入）：`status-tab-departure-fallback.mjs`（决策 2 的对照回路）、`status-nav-duplicate-loop.mjs`（决策 3，用 `ROW=16` 跑）、`status-write-error-visible.mjs`（决策 4，打桩 409/200 + 截图）。另两条随修复删除：`status-select-stale-after-nav.mjs`（被证伪的 `key`/`useState` 猜测，仅在本 ADR 留反例）、`status-duplicate-row-prevnext.mjs`（依赖 tracker 里真的存在重复行号，数据修复后已无法运行，其场景由打桩 409 的那条覆盖）。
