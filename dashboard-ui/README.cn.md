# dashboard-ui/

career-ops **网页版 dashboard** 的 Windows 启动器——把 web UI（`web/`）打包成可双击运行的启动器。两个构建变体，都由同一份 Go 源码（`launcher.go`）编译：

- **`career-dashboard-ui.exe`** —— GUI 子系统（`-H windowsgui`，无控制台窗口），由打包器注入 `cacheVersion` 戳。是常规双击目标。
- **`career-dashboard-launcher.exe`** —— 控制台子系统变体（同一程序，无 `-H windowsgui`），日常双击入口。它会弹出一个**自持的日志窗口**实时显示启动过程与服务输出（见下「运行日志」）；同时仍把日志打到 stdout，便于脚本抓取。用 `BUILDFULL=0` 单独构建。

## 它是什么

两个 exe **都不内嵌** Node 运行时。启动时 launcher 按顺序在自身目录旁寻找运行时：

1. exe 旁边的 `node.exe` + `app/server.js`（`locateSelfHostedRuntime`），或
2. exe 旁已解压的运行时缓存 `.dashboard-runtime\v{N}\`（node.exe + app/）——完整构建/`career-dashboard-ui.exe` 之前运行产生的布局。

两者都没有时，launcher 会报告 `dashboard runtime not found` 并退出。

找到运行时后它会（端口严格固定 3000，见 ADR-0063，不再有“选空闲口”与锁文件）：

1. 以**自身可执行文件目录**为锚点确定 career-ops 根目录——从 exe 所在位置读取 `cv.md` / `data/` / `reports/`（与 Go TUI 一致），
2. 探活 3000：已有活实例则复用（再次双击只重开浏览器），无应答且被占用则杀进程树后接管，空闲则直接起服，设置 `CAREER_OPS_ROOT` / `PORT=3000` / `HOSTNAME=127.0.0.1` 后启动服务器并等待其响应，
3. 在 `http://localhost:<port>` 打开默认浏览器（**本启动器交给用户或用于健康轮询的访问地址一律 `localhost`，不用 `127.0.0.1`**——fork 家规见 `modes/_custom.md`；浏览器扩展仍探测 `127.0.0.1`，见 `extension/background.js`）。`HOSTNAME` 是**监听**地址，保持显式 IPv4 字面量：Windows 下 `localhost` 先解析到 `::1`，绑成 `localhost` 会只监听 IPv6 回环。绑 `127.0.0.1` 仍可用 `localhost` 访问——Chromium / .NET / Node（autoSelectFamily）都会回退——且与调试工作流 `http://localhost:3000` 同源，localStorage 偏好共享。然后保持常驻（若已有实例在运行则复用之——再次双击只会重新打开浏览器）。

进程启动后驻留在**系统托盘**（不在任务栏）。右键托盘图标有菜单：

- **打开面板** —— 在默认浏览器重新打开 dashboard，
- **显示日志窗口** —— 唤回被隐藏的日志窗口（见「运行日志」），
- **重启服务** —— 杀掉并重启内嵌服务器（端口恒为 3000，重新打开浏览器），
- **退出** —— 停止服务器、退出 launcher。

托盘 tooltip 实时外显服务状态：`就绪 :3000` / `服务已退出` / `启动失败`。左键点击托盘图标无动作（只有菜单）。图标复用内嵌的 `icon.ico`。

## 运行日志（工单 01–02 / ADR-0066）

launcher 把**自身决策**（接管/杀占口/起服/就绪）与 **dashboard 服务子进程的 stdout/stderr** 汇入同一条时间线，逐行加 `[HH:MM:SS] [launcher|server]` 前缀，同时送往：自持的**日志窗口**（Win32 只读编辑框，实时滚动）与磁盘文件 **`.career-ops-web/launcher.log`**（每次 launcher 进程启动即重置）。启动时 conhost 控制台被隐藏（其窗口归 conhost 进程、无法拦截关闭改隐藏，故改用自持窗口）。

- 日志窗口的 × 只是**隐藏**，不影响 launcher 与服务生死；托盘「显示日志窗口」唤回。
- 启动失败不再让进程蒸发：关掉错误框后 launcher 驻留托盘，随时可唤回窗口查完整死因。
- 旧 `.dashboard-runtime\v{N}\tray-debug.log` 通道已退役（路径随版本漂移、就绪前日志丢失），由上述固定路径取代。

## 目录结构

| 文件 | 用途 |
|------|------|
| `launcher.go` | Go 启动器——定位运行时、启动服务器、托盘生命周期 |
| `tray.go` | 托盘控制器接口（命令通道、quit/done） |
| `tray_windows.go` | Windows 托盘实现（systray 菜单：打开面板/重启服务/退出） |
| `tray_other.go` | 非 Windows 托盘 stub（no-op） |
| `platform_windows.go` / `platform_other.go` | 平台相关的 `startServer`（隐藏窗口 vs no-op） |
| `open_windows.go` / `open_other.go` | 平台相关的打开浏览器 / 错误对话框辅助 |
| `go.mod` / `go.sum` | 模块（依赖：`golang.org/x/sys` + `fyne.io/systray`，后者由本地 vendored fork `replace`） |
| `third_party/systray/` | `fyne.io/systray` v1.12.2 的本地 vendored fork，带一行 Windows 修复（见 `third_party/systray/PATCH.md`）——上游在 `TrackPopupMenu` 之后从不 post `WM_NULL`，所以托盘右键菜单只在第一次右键时出现 |
| `gen-icon.py` | 用 Pillow 绘制应用图标（`icon.ico`）的脚本 |
| `winres/winres.json` | go-winres 资源定义（图标 + 版本信息） |
| `winres/icon.ico` | 应用图标（受版本控制；可用 `gen-icon.py` 重新生成） |
| `build-dashboard-ui.mjs` | 端到端打包脚本 |
| `start-dashboard.js` | 基于 Electron 的启动器替代（`node dashboard-ui/start-dashboard.js`）——见 `README-script.md` |

## 构建

```bash
node dashboard-ui/build-dashboard-ui.mjs      # 两个变体
BUILDFULL=0 node dashboard-ui/build-dashboard-ui.mjs   # 只编 launcher（约 9 MB）
```

脚本会：

1. 在 `web/` 中运行 `next build`（standalone 输出），
2. 把 `.next/static` 复制进 standalone 目录树（Next 不会自动做），
3. 从 standalone 目录树剥离开发/追踪杂物（`src/`、`tests/`、日志、配置），
4. 把干净的目录树复制进 `app/`（launcher 读取的运行时源），并把当前运行的 Node 二进制复制为 `node.exe`，
5. 用构建的 git SHA / 时间戳 / cacheVersion 写入 `app/build-info.json`，
6. 用 go-winres 重新生成 `.syso` 资源（图标 + manifest + 版本），
7. 把变体编译到仓库根目录（`career-dashboard-ui.exe`，以及 `BUILDFULL=0` 之外的 `career-dashboard-launcher.exe`）。

需要 **Node 20+**（Next 16 引擎下限）、**Go 1.24+** 和 **go-winres**（首次运行时自动安装到 `.gobin/`）。先确认环境：

```bash
node --version   # 需 ≥ v20
go version       # 需 ≥ go1.24
```

### 打包产物

- **输出：** 仓库根目录下的 `career-dashboard-ui.exe` 和 `career-dashboard-launcher.exe`（各约 9 MB）。两者都**不内嵌**运行时——服务器二进制（`node.exe`）和 Next standalone 目录树位于 `dashboard-ui/` 下的 `app/` / `node.exe`（构建产物，git 已忽略），启动时必须位于 exe 旁或 `.dashboard-runtime\v{N}\`。
- **耗时：** 一般机器约 1–3 分钟（首次会安装 go-winres，更久一些）。旁边跑着 `next dev` 也不冲突——构建写入的是独立的输出目录。
- **缓存版本：** `cacheVersion` 由构建自动注入（构建时的 git SHA，外加树不干净时的 `-dirty`），因此重新构建绝不会复用旧的 `.dashboard-runtime\v{N}` 解压。

### 验证构建产物

```bash
# 1. 确认 exe 存在且时间戳是最新的
Get-Item career-dashboard-launcher.exe

# 2. 在 exe 旁提供运行时（node.exe + app/server.js），或先跑一次 launcher
#    ——存在时会读取 .dashboard-runtime\v{N}\。

# 3. 启动并验证 API 是否应答（端口固定 3000，无锁文件，见 ADR-0063）：
.\career-dashboard-launcher.exe
Invoke-WebRequest "http://localhost:3000/api/version"   # 期望 HTTP 200

# 4. 诊断：若行为异常，看自持日志窗口，或读统一启动器日志
Get-Content .career-ops-web\launcher.log
```

### 常见问题

| 现象 | 解决办法 |
|------|----------|
| `go: command not found` | 安装 Go 1.24+ 并加入 `PATH` |
| 首次打包 go-winres 安装失败 | 检查网络 / `GOPROXY` 后重试；成功后缓存在 `.gobin/`，之后不再安装 |
| 启动时报 "dashboard runtime not found" | 在 exe 旁放 `node.exe` + `app/server.js`，或把运行时解压进 `.dashboard-runtime\v{N}\`（跑一次完整构建会准备好 `dashboard-ui/app` + `dashboard-ui/node.exe`） |
| exe 启动了但浏览器没弹出来 | 看日志窗口或读 `.career-ops-web/launcher.log`（始终会写） |
| 重新打包后网页还是旧版 | `cacheVersion` 来自 git SHA + dirty 标记；干净重建会生成新的 `.dashboard-runtime\v{N}` 目录——若没变，先确认 exe 时间戳确实更新了 |
| 弹「服务意外退出」/「启动失败」对话框 | 关掉框后托盘驻留；托盘「显示日志窗口」看完整死因，「重启服务」重试 |

日志窗口与 `.career-ops-web/launcher.log` 逐行同源；窗口的 × 只隐藏不退出（工单 02）。GUI 变体（`-H windowsgui`）无控制台，日志主要靠窗口与文件。

## 说明

- `app/`、`node.exe`、`.gobin/` 和 `*.syso` 是构建产物，已在 git 中忽略。
- web 构建自托管字体（`web/public/fonts`，通过 Fontsource + `next/font/local`），因此生产构建可以离线运行——无需访问 `fonts.googleapis.com`。
