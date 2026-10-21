# 托盘 Electron 化 · 真机验收记录 — 2026-10-21

- 对应工单：`.scratch/tray-electron-flyout/issues/07-acceptance.md`（ADR-0086 决策 3 / 4 / 6 / 9）
- 被验收产物：`career-tray/CareerDashboardTray.exe`（**246,201,856 B**，2026-10-21 **12:11:12**）
- 执行环境：Windows 11 25H2，单屏 1920×1080 @100%（DISPLAY1，任务栏自动隐藏）；Node 22.23.2；Electron 44（随包 320 MB）；Go 1.26.7（回滚路径）
- 结论：**可交付**。15 条清单里 **13 条 ✅**，2 条本机环境无法覆盖（G11 副屏、G12 任务栏换边）。验收中查出 10 处实现缺陷，全部当场修掉并在本产物上复验。
- 证据目录：`.scratch/tray-acceptance-20261021/`（截图、JSON、打包日志；不进版本控制）

## 0. 重打包产物验证四判据

| 判据 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| exe 时间戳 / 体积 | 与本次构建同时刻、目录 320 MB | `246,201,856 B @ 2026-10-21 12:11:12` | ✅ |
| `/api/version` | `packaged=true`、`sha` 与构建一致、`coreVersion` 有值 | `{"version":"web 0.7.2","coreVersion":"1.28.0","sha":"739f47b","builtAt":"2026-10-21 04:10 UTC","packaged":true}` | ✅ |
| HEAD sha | 与产物 sha 一致 | `git rev-parse --short HEAD` = `739f47b`（工作树脏 → cacheVersion `739f47b-dirty`） | ✅ |
| `.dashboard-runtime` | 只剩 `v{build-info.cacheVersion}` | 只有 `v739f47b-dirty` | ✅ |

产物结构自检（`pack-launcher.mjs` [5]）：`version.json=739f47b-dirty` ✅｜`locales` 只有 `en-US.pak, zh-CN.pak`（2 个）✅｜`resources/default_app.asar` 已删 ✅。

## 1. 场景记录

### A. 冷启动（打包产物，3000 空闲）

| 项 | 记录 |
| --- | --- |
| 做了什么 | 杀干净托盘与 node → 直接起 exe（无 3000 占用），起 4 次复测 |
| 托盘出现 → 服务就绪 | 12:13:12 → 12:13:18（**6 s**）；另测 11:49:21→11:49:28（7 s）、11:16:28→11:16:32（4 s）、11:51:43→11:51:46（3 s）。差异来自文件缓存与磁盘忙闲 |
| 四条日志 | 齐全：`launcher 启动`（12:13:12）→ `接管决策：3000 空闲，直接起服`（12:13:13）→ `已派生服务子进程 pid=61288`（12:13:13）→ `服务就绪`（12:13:18） |
| 浏览器 | 就绪后 `openBrowser()` → `shell.openExternal('http://localhost:3000')`（与旧 Go 行为一致；本轮未逐次截图浏览器窗口） |
| 首帧数据 | 面板第一眼即 `20 条在册 / 投递中 4`，无 `—`（见 2.4 的冷启动修复） |

### B. 热启动 / 单实例

第二次起 exe → 单实例锁生效，没有第二个托盘图标；`second-instance` → `toggleFlyout()`（与托盘左键同一条路径）。开→关→开切换正常；`tasklist` 始终只有一棵 `CareerDashboardTray.exe` 进程树（主进程 + renderer + gpu + utility）。

### C. 外部实例（3000 上已有应答的 career-ops）

| 项 | 记录 |
| --- | --- |
| 做了什么 | 手工用 `.dashboard-runtime\v739f47b-dirty\node.exe server.js` 起服务（pid 62356，`/api/version` 200）→ 再起托盘 |
| 日志 | `接管决策：3000 已应答，复用现有实例（服务输出归持口实例，本壳不记，退出不杀）`（12:00:07） |
| 面板 | 服务行带中性 chip `外部实例`；无「已运行 xh」伪造时长；重启按钮置灰，`title` 为「外部实例不受本壳管理」——桌面自动化读到的菜单态亦为 `重启服务 enabled=False` |
| 数据 | 健康 7–23 ms、pid 62356、`20 条在册`，3/3 次复测一致 |
| 退出 | 见 H14 |

### D. 端口被无应答进程占用

用 `.scratch/tray-electron-flyout/squatter.cjs` 占住 3000（`http.createServer(()=>{})`，只收不回，pid 53632）→ 起托盘：

```
[11:11:47] [launcher] 接管决策：3000 被 node.exe(pid=53632) 占用且无应答，杀进程树后起服
[11:11:48] [launcher] 已派生服务子进程 pid=61632，等待就绪（最长 60s）…
[11:11:55] [launcher] 服务就绪：http://localhost:3000
```

复查：占用者 53632 已不存在，3000 由 61632 持有。✅

### E. 启动失败

工单原写法是「把 `app/server.js` 改名」。实测那会命中**更早的一道闸**：`locateRuntime` 校验 `node.exe + app/server.js` 齐全 → 弹「dashboard runtime not found」模态框后退出（与旧 Go 的 fatal 行为一致）。所以两种子场景都测了：

| 子场景 | 现象 | 结论 |
| --- | --- | --- |
| E1 运行时缺件（改名 `server.js`） | 日志 `dashboard runtime not found. Run: node dashboard-ui/build-dashboard-ui.mjs`，模态错误框，关闭后进程退出 | ✅ 属「运行时缺失」的既有语义，不是「服务启动失败」 |
| E2 服务启动即崩（`server.js` 换成 `console.error(...); process.exit(1)`） | 同一秒内红：`[server] boom: simulated startup crash` + `启动失败：dashboard 服务意外退出（code=1）`；面板 pill「启动失败」、服务行「未就绪」、原因红字、主按钮变「重新启动」；**壳不退出** | ✅ 工单靶心 |
| 恢复 | 还原 `server.js` → 点面板「重新启动」→ `重启：先停旧子进程…` → `服务就绪` → 面板回「运行中」 | ✅ |

冷启动超时（60s）不再空等：子进程一死就 `markFailed`，`waitReady` 立刻返回并保留准确死因（见 2.5）。

### F. 面板

| 细项 | 记录 |
| --- | --- |
| 四态 × 深浅主题（8 张） | `state-{run,starting,down,failed}-{light,dark}.png`。`--theme=` 是本次新增的调试开关（只改 `nativeTheme.themeSource`，不写系统设置） |
| 与原型并排比对 | `.scratch/tray-flyout/prototype.html` 的配色、圆角、橙色主按钮、四柱 + 数值 + 下标一致；差异仅两处已知偏离（见第 3 节） |
| 柱状数字核对 | `/api/tracker` 实返 20 行 `{evaluated 8, applied 4, skip 4, discarded 4}` → 面板 `投递中 4 / 有回应 0 / 面试中 0 / Offer 0`、`20 条在册`，逐位一致 |
| 点柱跳转 | `<g data-k="applied">` → `app:openTab('applied')` → `http://localhost:3000/pipeline?tab=APPLIED`；`followups` 走 `/followups`。事件链与映射逐行核对（浏览器新标签页内容未逐条比对） |
| 跟进 0 项 / 3 项 | 槽位固定 110px（3 行），卡片高度 **548 → 548 不变**；0 项时居中显示「没有到期跟进」。此项首轮为 ❌（472 vs 548，面板会跳），已修 |
| Esc 收起 | Win32 `IsWindowVisible` 由 `true` → `false`（`document.visibilityState` 在 Electron 里对隐藏窗口不可靠，故用 Win32 判定） |
| Tab 焦点可见 | 图表柱可聚焦（`aria-label="投递中 4 条，打开仪表盘筛选"`），焦点环用 `stroke 1.6px`（`outline` 显式置 none）；`rowRestart`/`rowLogs` 带 `aria-label`（重启服务 / 显示日志窗口） |

### G. 多屏与 DPI — **本机无法覆盖**

| 项 | 结论 |
| --- | --- |
| G11 副屏（不同缩放） | ❌ 未测：本机只有一块显示器（DISPLAY1 1920×1080 @100%）。几何逻辑由 `flyout-position.test.cjs` 的负坐标副屏用例覆盖（按该屏 `workArea` 夹取） |
| G12 任务栏换到顶部 | ❌ 未测：Windows 11 已移除任务栏换边设置。由 `flyout-position.test.cjs` 的「锚点在左上 → 向下挂」用例覆盖 |

这两条要真机覆盖，需要外接/虚拟显示器与 Win10 或第三方任务栏；已在此写明，未开修复单（不是实现缺陷）。

### H. 退出

用桌面自动化（UIA）真的点托盘右键菜单：任务栏自动隐藏 → `^` 溢出浮层 → career-ops 图标 → `Shift+F10` 唤出同一张上下文菜单 → 点「退出」。

| 子场景 | 记录 |
| --- | --- |
| H13 owned（自己起的服务） | 进程全消失（`CareerDashboardTray.exe` 0 个、`node.exe` 0 个）、3000 释放；日志两条：`退出：结束服务子进程 pid=66860`、`托盘退出` |
| H14 外部实例 | 托盘 0 个，外部实例 62356 仍在、`/api/version` 仍 200、`0.0.0.0:3000` 仍在 LISTENING；日志：`退出：3000 上是外部实例，不杀（owned=false）`、`托盘退出` |

自动化留证：`quit-before.png`、`quit-final-check.png`。

### I. 数据回路

| 项 | 记录 |
| --- | --- |
| 评估在跑计数（真跑） | 13:26 真发起一次 `kind=evaluate`（claude / haiku，内联 JD 探针）→ `POST /api/run` 200 + `runId=03ac331b…` → `/api/active-runs` `running=1` → 面板「评估 **1 在跑**」（`panel-runs-during.png`）→ `POST /api/run/cancel` `ok:true` → `running=0` → 面板回「空闲」（`panel-runs-after.png`）。取完证据即撤销，**零副作用**：`reports/` 无新文件、无 `*RESERVED*` 哨兵、`batch/tracker-additions/` 无新 tsv、tracker 仍 20 行 |
| 刷新节奏（验收中发现的事实） | 面板只在「打开」（`toggleFlyout → refreshBusiness`）或 15s 轮询时重拉业务数据；跑得比一个轮询周期短的评估，开着面板等不到「1 在跑」——这是工单 04 定下的节奏，不是缺陷（重新开一次面板即可看到当前值） |
| 跟进到期与 `/followups` 一致性 | 当前 `due=0`（`0 项到期`），两态渲染用注入快照验收（见 F），**没有**为验收去改用户数据 |

## 2. 验收中查出并修掉的缺陷

| # | 现象 | 根因 | 修法（文件） |
| --- | --- | --- | --- |
| 1 | 面板卡片右侧被裁 20px | 窗口宽 384 = 卡片宽 384，但 `body` 有 10px 阴影留白 | 窗口宽 = `384 + 2×10`（`src/main.cjs`） |
| 2 | 四柱图读不出漏斗（64 与 1 几乎等高） | 工单公式 `0.62 + 0.38·log` 压缩过度 | 改纯 `log` + 6px 基线桩，实测柱高 40/24.6/15.4/6.6（`ui/panel.js`） |
| 3 | 图表柱可聚焦但看不到焦点环 | `:focus-visible` 只写了 `outline:none` | 加 `stroke 1.6px` 焦点环（`ui/theme.css`） |
| 4 | 外部实例场景面板一度显示「已停止」 | 服务冷启动时首个请求 >1.5s，两次探测超时即判 down，而 3000 一直 200 | 超时放宽到 2.5s；判 down 前补 TCP 复核（端口在听就保持 run）；端口在听但连超 30s 才认输（`src/service.cjs`） |
| 5 | 启动即崩时空等 60s 才变红，且死因被「未就绪」覆盖 | `waitReady` 不感知子进程已退出 | `facts.failed` 后立即返回并保留原死因（`src/service.cjs`） |
| 6 | 冷启动后面板第一眼全是「—」 | 起服期间就拉业务数据必然失败；就绪后要等 15s 轮回填 | 就绪即补拉一次；**首个 `/api/tracker` 实测 >5s**（要现编译路由 + 建索引，第二轮 0.5s）→ 首轮超时给 20s，常驻轮询 5s（`src/main.cjs`、`src/snapshot.cjs`） |
| 7 | 业务拉取期间「健康 xx ms」闪成空 | 健康探测与业务请求抢同一个单线程服务 | 业务在跑时跳过健康探测，但超过 10s 照探（`src/main.cjs`） |
| 8 | 跟进 0 项与 3 项时面板高度跳 76px | 待跟进槽位没有预留高度 | 槽位固定 110px（3 行），空态框居中（`ui/theme.css`） |
| 9 | 一次「上一个实例还在拆句柄」的重启，整场没有 `launcher.log` | `createWriteStream` 异步 open 失败只变成 error 事件 | 失败退避重试 4 次再降级为仅内存（`src/logger.cjs`） |
| 10 | 面板在无版本信息时读成「—dev」 | dev 标记无条件追加 | 标签为「—」时不追加 dev（`ui/panel.js`） |

另外顺手补的两处可观测性：`httpJson` 现在带回 `error` 码；业务块降级时日志写一行 `业务数据降级：<path> status=… ms error=…`（同一签名只报一次），否则线上分不清「服务慢」还是「接口 500」。

单测：`node --test "tray-shell/tests/*.test.cjs"` → **47/47 通过**（新增 `service.test.cjs` 4 条、业务降级 1 条）。

## 3. 对工单的偏离（已知、有意）

| 偏离 | 工单写法 | 实现 | 理由 |
| --- | --- | --- | --- |
| 柱高公式 | `0.62 + 0.38·log10(1+n)/log10(1+max)` | `max(6, log10(1+n)/log10(1+max) × 40)` | 原式在 64 vs 1 时只差 5px，漏斗读不出来 |
| 面板窗口尺寸 | 384 宽 | 404 宽（384 卡片 + 2×10 阴影留白），高度贴内容（当前 568） | 否则卡片右侧被裁 |
| 跟进槽位 | 「0 项时同一位置写『没有到期跟进』，槽位高度固定」 | 固定 110px（3 行）+ 空态居中 | 实现工单要求本身 |
| 新增调试开关 | 只有 `--state=` | 另加 `--theme=dark\|light` | 验收要截深色/浅色两套，且不能改用户系统设置 |

## 4. 回滚路径（`--shell=go`）仍可用
`node dashboard-ui/build-dashboard-ui.mjs --shell=go` → `career-dashboard-launcher.exe`（**9.0 MB, subsystem=GUI**，PE 子系统校验通过）。冷启动实跑：12:09:20 → 12:09:22 就绪，`/api/version` `packaged=true`，旧托盘菜单在位（`打开面板 / 重启服务 / 分隔线 / 退出`）。回滚开关没有随 Electron 化一起烂掉。

## 5. 遗留观察（不在本工单收口范围）

- **托盘与它的服务在同一次消失中都没留下日志**：12:14 起的实例跑到 13:23 之后不见了，`launcher.log` 停在最后一条 `业务数据降级`，既没有 `退出：…` 也没有 `启动失败：…`；Windows 应用事件日志在 ±5 分钟窗口内也没有 `CareerDashboardTray` 的崩溃记录。按日志语义，这只能是**外部强杀**（任务管理器 / 进程树清理）而不是壳自己的任何退出路径——壳的每条退出/崩溃分支都会落日志。记录在此，后续如再现再查（不影响本轮交付）。
- 同日 13:10–13:23 期间出现过几次 `/api/tracker`、`/api/followups` 超过 5s（包括一次四路全超时）：当时正在并发探测 CLI 列表，Next 单线程服务被堵。降级路径按预期工作（只会让对应块短暂显示「—」，下一次轮询自行恢复），且没有误判成「服务已停止」。

## 6. 复现命令

```powershell
# 打包（含结构自检 + 拉起验证 + 清旧 runtime）
node local/pack-launcher.mjs

# 单测
node --test "tray-shell/tests/*.test.cjs"

# 打开调试端口，用 Playwright 连真窗口取面板快照与截图
Start-Process career-tray\CareerDashboardTray.exe -ArgumentList "--remote-debugging-port=9222"
node .scratch\tray-electron-flyout\read-panel.mjs --out=panel --open

# 四态 × 深浅主题截图
node .scratch\tray-electron-flyout\shoot-real-states.mjs

# 场景 D 的僵尸占用者
Start-Process node -ArgumentList ".scratch\tray-electron-flyout\squatter.cjs"

# 场景一：真跑一次评估看「1 在跑」→ 取消 → 「空闲」（零副作用）
node .scratch\tray-electron-flyout\probe-run-count.mjs

# 回滚旧 Go 壳
node dashboard-ui/build-dashboard-ui.mjs --shell=go
```
