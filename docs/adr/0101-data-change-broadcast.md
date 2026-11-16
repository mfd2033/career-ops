# ADR-0101: 用户层数据变更即推——追踪层写入经 /api/events 广播，已打开的页面就地刷新

## 状态

Accepted (2026-11-16)

## 背景

现象：在招聘站页面用扩展浮窗/卡片胶囊改投递状态，切回 career-ops 的求职管道页，状态还是旧的；手动刷新（F5）或切到别的页再回来才正确。

排查结果（本条按事实记，不含推断）：

1. **写入链路正常。** 扩展 `set-status` → SW 转发 `POST /api/status` → `set-status.mjs` 持锁改 `data/applications.md` 并追加 `status-log.tsv`。用不存在的行号打这条接口得到 `404 {"code":"not-found"}`，说明路由与 CLI 都在跑。
2. **服务端渲染不缓存。** `/pipeline` 是 `force-dynamic`，每次请求 `readApplications()` 从磁盘重读（`career-ops.ts` 的 `read()` 直读 `fs.readFileSync`，没有任何表级缓存；报告事实缓存按 mtime+size 失效）。实测抓取 `/pipeline?q=1333` 的 HTML，内容与 `applications.md` 当前行一致。
3. **缺的是「已经打开的标签页」。** `PipelineView` 只在两种时机 `router.refresh()`：自身的跳过/批评估操作，以及 `co-job-done` 窗口事件（批评估收尾）。没有任何通道监听**别人**写入——包括扩展、另一个标签页、`/api/tracker` 的其它调用方。
4. **唯一的常驻长连接已经有了，但只跑 run 事件。** ADR-0020 的 `/api/events` 由 job-store 每标签页持一条（挂载即连、断线重连），线协议是 `{runId, ev}` 加通道级 `{type:"keepalive"}`；job-store 对无 `runId` 的帧一律 `continue`。

所以这不是写入缺陷，是**缺少通知链路**：数据在磁盘上是对的，浏览器里那份渲染结果没人告诉它该重取。

## 决策

1. **新增进程内「数据变更」总线** `web/src/lib/data-events.mjs`：`publishDataChange(scope, detail?)` / `subscribeDataChanges(fn)`。**不缓冲、不重放**——一次变更只是「去重取一次」的提示，错过它的代价是这个标签页保持原样，而它本来就会在下次导航时自愈。
2. **复用 ADR-0020 的唯一长连接，不新开连接。** `/api/events` 额外广播**通道级帧** `{type:"data-changed", scope, ts}`：不带 `runId`，因此不认识它的旧客户端按「无 runId 帧」忽略，向后兼容；帧里**只有 scope，不带行号与字段值**——接收方整体 `router.refresh()`，不装配第二份数据。
3. **写路径在成功后发布。** 发布点限定为真正改了 tracker 的调用：
   - `POST /api/status`（仅 `parsed.changed === true`）
   - `POST /api/tracker`（新增行）、`PUT /api/tracker/upsert`、`PATCH /api/tracker/[id]`
   - `POST /api/tracker/delete`（非 `dryRun`）

   `tracker query` / `history` / `health` / `sync` 不发布：前三个是读，`sync` 重建索引不改用户可见数据。
4. **客户端只挂一个桥。** job-store 是唯一连接的持有者，它把该帧转成窗口事件 `co-data-changed`（与既有 `co-job-done` 同一口径）；新增 `DataFreshnessBridge` 在 app-shell 挂一次，收到事件后**防抖 400ms** 调 `router.refresh()`，把同一批写入合并成一次重渲染。
5. **不做轮询、不加 UI。** 没有「已同步」提示、没有新按钮：用户看到的应当就是数据本身变了。

## 被拒方案

- **数据指纹轮询**（页面每 N 秒查一次 `applications.md` 的 mtime+size）：要多一条常驻定时器与请求，延迟固定为 N 秒，而 SSE 通道本来就在；同一个「该刷新了」的信号没必要造两套传输。
- **每个页面各开一条 `/api/events`**：直接违反 ADR-0020 的单连接约束（HTTP/1.1 同源 6 条，多开几条就把点击挤没了）。
- **页面里轮询 `/api/tracker?limit=1`**：这条会 spawn 一个 Node 子进程（ADR-0098 实测 411ms），比它要防的「渲染重」还贵。
- **写路径直接 `revalidatePath` / 改 RSC 缓存**：`/pipeline` 等页面是 `force-dynamic`，没有可失效的缓存；它解决不了「浏览器里已经渲染好的那一份」。
- **无条件定时 `router.refresh()`**：报告页一次渲染要解析报告与 tracker，定时重渲染既浪费又会打断正在输入的表单（客户端草稿虽在 useState 里，但滚动/焦点会被动一下）。
- **帧里带上「第几行、旧值→新值」让页面局部打补丁**：等于在客户端再维护一套 tracker 装配逻辑，与 `applications.md` 的解析口径迟早漂移；一次整体刷新拿到的就是真值。

## 后果

- 正面：扩展在招聘站改状态（或任何 web 端写行/改行的动作）之后，所有已打开的数据页在半秒内自动更新；不新增连接、不新增轮询、不新增界面。
- 代价一：一次写入会让**所有**打开标签页刷新，包括发起方自己（它已经 `router.refresh()` 过一次）——多一次冗余渲染，由 400ms 防抖把同一批写入压成一次。
- 代价二：总线是进程内的，且刻意不留历史；web 服务重启期间发生的写入不会被补推。这类情况本来就要靠下一次导航自愈。
- 已知边界（不绕）：在终端里直接跑 `set-status.mjs`、或评估 worker 子进程写 tracker，都**不经过** web 进程，因此不发布事件。前者靠手动刷新，后者的「本标签页内」路径仍由既有 `co-job-done` 覆盖；跨标签页的 worker 收尾仍是老样子（`/api/active-runs` 轮询）。
- 回滚：删掉 app-shell 里的 `<DataFreshnessBridge />` 即回到手动刷新；`/api/events` 多出的通道级帧对任何客户端都无副作用。

## References

- 复用与约束对象：`docs/adr/0020-worker-event-multiplexing.md`（单连接多路复用、通道级帧先例 `keepalive`）
- 写入链路与本条要治的写失败可见性：`docs/adr/0036-report-nav-context-and-write-failure-visibility.md`
- 路由侧事件循环预算（为什么不在客户端加轮询、不每页开连接）：`docs/adr/0098-web-route-event-loop-budget.md`
- 扩展侧写回入口：`docs/adr/0074-report-status-contract-and-inpage-reader-modal.md`、`extension/background.js`（`set-status` 分支）
- 实现落点：`web/src/lib/data-events.mjs`、`web/src/app/api/events/route.ts`、`web/src/lib/tracker-api.ts`、`web/src/app/api/status/route.ts`、`web/src/app/api/tracker/delete/route.ts`、`web/src/components/jobs/job-store.tsx`、`web/src/components/data-freshness-bridge.tsx`、`web/src/components/app-shell.tsx`
- 单测：`web/tests/lib/data-events.test.mjs`
- 工单：`.scratch/data-change-broadcast/issues/`
