# ADR-0066: launcher 日志窗口——自持 Win32 窗口、关窗即隐藏、统一日志随进程重置

- **Status:** Accepted (2026-09-26；同日实现时修订窗口机制，见 Decision 1/3 与修订说明)
- **Context:** 需求（2026-09-26，四轮 grilling 敲定）：launcher 启动后能看到后台服务运行情况（启动过程、日志输出）。现状三个断层：
  1. `startServer`（`dashboard-ui/platform_windows.go`）spawn `node server.js` 时未接 `cmd.Stdout/Stderr`，服务输出被 Go 默认丢进 NUL；
  2. `setupTrayLog`（`launcher.go`）在服务**就绪之后**才把 launcher 自身日志重定向到 `.dashboard-runtime\v{版本}\tray-debug.log`——启动期最关键的接管决策全部丢失，且路径含版本号，重打包后日志位置漂移；
  3. 双击的 `career-dashboard-launcher.exe` 是控制台子系统变体（构建不带 `-H windowsgui`），本机其实**已有一个控制台窗口**，只是就绪后静止、永远等不到服务输出。实现工单 02 时发现：Win10/11 该控制台窗口归独立进程 **conhost.exe** 所有，本进程既不能给它 subclass `WM_CLOSE`（跨进程窗口），也无法用 `SetConsoleCtrlHandler` 可靠否决关闭（`CTRL_CLOSE_EVENT` 返回 TRUE 也拦不住系统约 5s 后终止进程）——故「复用控制台」无法可靠实现「关窗即隐藏」，遂改为 launcher 自持窗口。

- **Scope:** `dashboard-ui/launcher.go`、`platform_windows.go`、`logwindow_windows.go`/`logwindow_other.go`（新增自持日志窗口）、`tray*.go`、`.career-ops-web/launcher.log`（新增，目录已 gitignore）、重打包产物。`tray-debug.log` 通道退役。**不动**：web 应用本体、ADR-0063 接管链语义、`start-dashboard.ps1/.js`、GUI 变体 `career-dashboard-ui.exe`、`pack-launcher.mjs` 的 detached 脚本拉起路径。

## Decision

1. **launcher 自持一个真实 Win32 日志窗口**（用已有 `golang.org/x/sys/windows` 手写，不引入重型 GUI 库）：启动即隐藏 conhost 控制台，日志时间线实时写入自持窗口的只读多行编辑框；同时镜像落盘 `.career-ops-web/launcher.log`。node 子进程 stdout/stderr 与 launcher 自身 `log` 输出全程走同一汇聚流（`logsink`，进程启动即生效，废除"就绪后才重定向"），逐行 `[HH:MM:SS] [launcher|server]` 前缀。自持窗口是为「可靠拦截关闭改隐藏」的前提——conhost 托管的控制台做不到（见 Context 3）。
2. **统一日志固定路径、生命周期跟 launcher 进程**：`.career-ops-web/launcher.log`，launcher 进程启动时 truncate；托盘「重启服务」只追加分隔行——崩溃现场正是重启前最想回看的东西。旧 `tray-debug.log` 退役，避免双通道漂移。
3. **关窗即隐藏**：自持日志窗口 subclass `WM_CLOSE` → `ShowWindow(SW_HIDE)`（不销毁），launcher 与服务生死不受影响；唤回入口为托盘菜单新增「显示日志窗口」（`ShowWindow(SW_SHOW)` + 置顶）。退出仍然只有托盘「退出」一条路。
4. **启动失败不再"弹窗后进程退出"**：60s 未就绪时模态对话框（现状 `fatal`=MessageBox，保留）关闭后 launcher 托盘驻留——tooltip 显示「启动失败」，菜单「显示日志窗口」可查完整死因，用户确认后才退出。失败是日志窗口价值密度最高的场景，现场不许蒸发。
5. **崩溃通知保留模态弹窗**（维持现状）：服务运行中途退出仍弹框 + 窗口实时呈现死前输出 + 落盘；tooltip 外显状态机「启动中… / 就绪 :3000 / 服务已退出 / 启动失败」（`SetTooltip`）。
6. **仅覆盖双击启动路径**（用户确认日常只有这一种）：`actionReuse`（探活命中即开浏览器退出）维持现状不记日志——服务输出属于持口的旧实例；脚本 detached 拉起无窗口可唤回，日志文件是唯一记录。

## Alternatives considered

- **复用继承来的 conhost 控制台作为可唤回窗口**（原计划）：实现时证伪——conhost 独立进程托管该窗口，跨进程无法 subclass `WM_CLOSE`，`SetConsoleCtrlHandler` 也拦不住关闭终止，「关窗即隐藏」无法可靠兑现；且强行拦截若失效会留下无托盘无监控的孤儿服务（正是要避免的）——改为自持窗口。
- **重型 Go GUI 库（walk/Fyne 等）**：为一个日志框引入整个 GUI 工具链，编译面与体积双增——被否，用已有 x/sys/windows 手写最小窗口即可。
- **托盘菜单派生 PowerShell `Get-Content -Wait` 窗口**：能覆盖任意启动方式，但多一个外部进程与 shell 差异面（本机 PowerShell 解析坑是已知负债）；双击场景下纯冗余——被否，留作未来静默自启需求出现时的升级路径。
- **web 界面日志页**：鸡生蛋——服务没起来时页面本身打不开，而"看启动过程"恰要在服务未就绪时看——被否。
- **沿用 tray-debug.log 只加前缀**：路径随 `.dashboard-runtime\v{版本}` 漂移，每次重打包日志位置就变，tail/回看都需要先解析版本目录——被否。
- **服务重启即清空日志**：窗口永远只有本次，但崩溃诊断现场同被抹掉，与决议 4 的初衷矛盾——被否。

## Consequences

- launcher 的退出语义收敛为唯一入口（托盘「退出」）；控制台 × 从此无破坏性。
- 日志可观测性覆盖"launcher 自己拉起的服务"这一条链路；dev server（`start-web.cmd`）与复用路径的输出仍走各自通道，本 ADR 不接管。
- 重打包后才能对日常双击入口生效（家规：打包前先停旧实例）。
- 验收以手动目视为主（GUI 三路径先例同 ADR-0063）：①双击→窗口实时可见启动过程→就绪横幅；②点 ×→窗口消失、服务活、托盘唤回；③杀掉 node→弹窗+tooltip「服务已退出」+日志含死前输出；④占口起服失败→弹窗+托盘驻留+可查日志。
