# ADR-0033: 体检可重复派发——同日去重废止，在跑时由用户裁决「停止 / 替换」

- **Status:** Accepted (2026-09-17)
- **Context:** 用户实测：报告页按「体检这家」，若该行当天已派发过体检，只得到一句「该行今天已派发过体检」（`pipeline.checkupAlreadyQueued`）。这道闸来自 ADR-0027 决议 4：`hasPendingCheckupRequest`（`web/src/lib/checkup-request.mjs:26-38`）按「同 tracker# + 当天」匹配 agent-inbox 里的两类行——ADR-0026 遗留的 pending 入队行（`- [ ]`）与每次派发时由 `/api/run` 写入的审计行（`- [x] … dispatched worker`，`route.ts:154-164`）——命中即 409。
  三个积累出来的毛病：① inbox 自 ADR-0027 起只是审计轨迹（drain 已跳过 `[x]` 行），却被当成闸门用；② 闸门按「当天」而非「是否在跑」，当天首次派发一旦失败（ADR-0030 记录的「上游中止 + 当天去重把重试堵死」），用户当天再也无法重试；③ 真正需要拦的「这一行正在体检」反而拦不住——判定只看 `job.status === "running"`（`checkup-request-button.tsx:117`），已派发但仍在池里排队（`queued`）时按钮照常露出，按下去又被 409 挡掉。
  另一面：重复体检本身是合理需求（体检可能失败、公司可能有新动向），「复检」按钮（已有体检记录时文案变「复检」）本来就承诺了按需再跑。决议于 2026-09-17 grill 会话逐条确认（15 项）。
- **Scope:** 只改按钮通路的拦截与交互（web 侧）。`lib/log-checkup.mjs` 的台账 schema、`modes/_custom.md` 的体检编排规则、checkup worker 的 prompt 均不动。会话 drain 执行的历史 pending 体检不在此列（它不经 web，无法登记在跑状态）。

## Decision

1. **同日去重废止，inbox 退回纯审计。** 删除 `hasPendingCheckupRequest` 与 409 `deduped` 分支，`pipeline.checkupAlreadyQueued` 文案随之删除。同日、跨日、pending、已派发一律不再拦截（连点由前端 busy 态兜住）；派发时写审计行照旧（派发时刻的轨迹），但它不再被任何闸门读取。唯一拦截 = 本行此刻有体检在跑（决议 2）。
2. **「在跑」由服务端登记表判定。** 新增单用途登记表（`web/src/lib/checkup-live.mjs`）：`/api/run` 派发 kind=checkup 时登记 `(tracker#, runId)`，run 终态时清除；`/api/checkup-request` 直接查它。判定**包含**已派发但仍在池里排队（`queued`）——登记发生在 `acquire` 之前，拿到池槽时（`route.ts:490` 已有的 await 处）把状态从 queued 翻成 running 并记 start 时刻。登记表是进程内存态，重启即清（与并发池、活跃运行视图同语义，ADR-0014 Q8）；跨标签页/跨浏览器可见，`停止` 所需的 runId 也由它给出（`/jobs` 只认本地卡片，活跃的 cross-session run 本无详情页，`jobs/[id]/page.tsx:36,45-61`）。
3. **前哨是闸门，`replace` 是唯一越权开关。** `/api/checkup-request` 的返回：无在跑 → `200 {ok}`；有在跑且未带 `replace` → `409 {running: {...}}`；带 `replace: true` → 服务端先把同 tracker# 的**所有**在跑体检停掉，再 `200 {ok, replaced: [...]}`（极端并发下收敛到单一写入方）。前端拿到 409 弹面板，拿到 ok 才 `startJob`。`/api/run` 不加守卫——闸门单点在 pre-flight，延续 ADR-0026 决议 5「后端设防」。
4. **面板两动作 = 「停止」与「停止并重新体检」（替换）。** 面板就地内联在按钮位置（house pattern：`delete-from-tracker.tsx`），含「正在体检中（已运行 X 分钟）」/「已派发，正在排队等并发槽」两种文案、`停止`、`停止并重新体检`、关闭，并明说「已产生的产出不回滚」。**不提供「保留旧的、另派一个」**：并行的两个体检会抢同一个 HTML 路径（`reports/checkups/{tracker#}-{slug}-{date}.html`，`_custom.md` 体检规则 3；台账 html 列只校验目录、不禁止重复路径，`lib/log-checkup.mjs:109-119`），也会并发追加同一份报告附录；替换让写入方始终唯一，无需为产物发明命名消解规则。
5. **「停止」= 硬停，产物不回滚。** 走现成的 `POST /api/run/cancel`（杀进程树、释放写令牌与池槽、账本记 error「cancelled by user」）；台账已 append 的行、已写的 HTML 与报告附录都不擦除（append-only 纪律与 ADR-0025「唯一机器通道」不许为一次取消开删除通路）。被取消的工作器卡片留在托盘显示「已取消」（与既有失败卡片留着的行一致，可点进 `/jobs/{id}` 看被杀前的输出）。
6. **替换要等旧进程真的死（checkup 局部确认）。** `terminateCli` 是 fire-and-forget（`spawn-cli.mjs:55-66` 的 taskkill 发完即返回），所以「取消完成」≠「进程已死」。登记表持有该 run 的子进程 exit 信号，替换路径 await 它（超时兜底 5s）后才放行。**超时仍放行**，但响应带 `unconfirmed: true`，页面明说「旧进程未确认停止，可能仍会产生写入」——不把不确定写成确定（ADR-0030 诚实门禁的同一种姿势），也不把环境问题变成用户阻碍。`cancel` 返回 false（run 已结束）按已停处理。共享的 `cancelRun` 语义不动（托盘 X 与其它 kind 的取消保持同步 fire-and-forget）。
7. **报告页的在跑可见性维持本地驱动。** chip 仍只反映本浏览器 jobs store 的卡片：跨会话派发的体检在本页看起来像空闲，按下按钮才由前哨的面板告知（此时没有 `/jobs` 链接可给）。不引入 SSR 读登记表，也不把登记表并入 `/api/active-runs` 轮询——活跃的 cross-session run 没有详情页，做实时同步只能得到死链，收益不抵复杂度。
8. **`/jobs` 保持只读。** 通用停止按钮（列表行或详情页）不属于本次改动：它是所有 kind 的共性问题，另行处理；托盘的 X 仍是通用停止入口。

## Alternatives considered

- **保留同日去重、只放宽 pending**：不合用户诉求（当天重试正是被它堵死的场景），且闸门依旧建在审计轨迹上。
- **只靠前端 jobs store 判在跑**：改动最小，但换标签页/换浏览器/服务重启后判不出，按下去会直接再派一个，「停止」也只能停本页知道的那个。
- **把 kind 加进并发池 meta 反查**：会放宽 batch 与浏览器扩展共用的池语义，为一个只服务 checkup 的判定付全局代价。
- **并存（保留旧的、另派一个）**：需要为同一 HTML 路径发明命名消解规则，且报告附录并发追加。
- **排队（等旧的结束后再跑）**：与「什么都没做」在观感上无法区分。
- **改共享取消语义（`cancelRun` 等 exit 再记终态）**：把一个等待加进所有取消调用方，收益不成比例；替换造出的窗口由替换自己关。
- **超时拒绝替换**：把环境问题变成用户阻碍；明说「未确认」已足以保持诚实。
- **SSR / 轮询让 chip 反映服务端在跑态**：撞上「活跃 run 无详情页」的既有限制（链接只能是死的）。

## Consequences

- 「体检这家 / 复检」任何时候都能按：没有在跑就直接派；有在跑就由用户裁决停或替换。ADR-0027 决议 4 被本 ADR 取代（其决议 6 继承的 ADR-0026 其余决议中「复检 = append 新行」继续有效）；ADR-0030 记录的「当天去重堵死重试」连带伤害就此消除。
- 台账仍 append-only：一次「停止并重新体检」可能留下两行（先前那次若已写出台账）+ 一份被覆盖的 HTML；`summarize` 按 slug 聚合的 min/max 星级能容纳这种情形。
- 登记表的键沿用 `/api/checkup-request` 已强制的数字 tracker#，与体检对象（Via）无关；`?` 行同样适用。
- 登记表是进程内存态：服务重启后在跑的体检不再被识别（与并发池、活跃运行视图同语义），下次按下会直接再派一个。
- 会话 drain 执行的历史 pending 体检不经 web、无法登记：此时按钮侧的判定看不到它（ADR-0027 决议 5 两条路并存的已知边界）。
- 删掉 `hasPendingCheckupRequest` 与对应去重测试矩阵；新增登记表纯函数测试与 pre-flight 契约测试（`running` / `replace` / `unconfirmed` 三个分支）。
