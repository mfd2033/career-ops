# ADR-0086: 用 Electron 托盘壳替换 Go/fyne 渲染层——状态化托盘图标 + 无边框 flyout 面板

## 状态

Accepted (2026-10-21)

## 背景

现状：`career-dashboard-launcher.exe` 是 Go + fyne/systray 写的常驻进程（`dashboard-ui/*.go`），
职责是「占住 3000 → 起 Next 服务 → 托盘驻留」。它的托盘**只能出原生菜单**（打开 / 显示日志 /
重启服务 / 退出），无法承载信息，也没有「点图标展开一块面板」这种交互。

参照对象：`D:\workspace\kaneo\.scratch\kaneo-tray`（Electron 44 壳，已在本机跑通并打包）。它证明了三件事：
托盘图标可以按状态着色（27 种预渲染组合）、无边框 flyout 可以贴鼠标点定位并失焦自动收起、
免安装打包不需要 electron-builder（copy 运行时 + 改名 + `resedit` 嵌图标）。

已完成的设计原型：`.scratch/tray-flyout/prototype.html`（可切四态 × 深浅主题，含图标 16/32px 对照）。
本 ADR 只决定**用什么渲染层、边界在哪**，视觉已在原型定稿。

既有约束（不可动）：

1. **端口固定 3000**（ADR-0063）：不漂移、不换端口，被占且无应答就杀占用者再起。
2. **服务运行时布局不变**：`.dashboard-runtime/v{cacheVersion}/node.exe` + `app/server.js`，
   由 `dashboard-ui/build-dashboard-ui.mjs` 产出；`/api/version` 的 `packaged/sha/coreVersion` 是打包自证。
3. **日志契约**（ADR-0066）：launcher 决策与服务 stdout/stderr 汇成一条时间线，
   逐行 `[HH:MM:SS] [launcher|server] …`，落在 `<careerRoot>/.career-ops-web/launcher.log`，**启动即截断**。
4. **打包编排**：`local/pack-launcher.mjs` 是唯一入口，停旧实例 → 清缓存 → 打包 → 启动 → 四判据验证 → 清旧 runtime。
5. **不引入安装器**：产物是「放进取件夹双击就跑」的免安装形态（与现状一致）。

## 决策

1. **新建 `tray-shell/` 作为 Electron 主进程壳，替代 Go 的托盘与窗口实现。**
   `dashboard-ui/` 的 Go 源码冻结保留（含单测），构建默认不再产出；一段时间内保留
   `build-dashboard-ui.mjs --shell=go` 作为回滚开关，删除另起 ADR。两套壳不并行分发。
2. **服务启动契约逐字不变**：`spawn(node.exe, ['server.js'], { cwd: <runtime>/app, windowsHide: true,
   env: { …process.env, CAREER_OPS_ROOT: <careerRoot>, PORT: '3000', HOSTNAME: '127.0.0.1' } })`。
   端口写死、绑定 IPv4 环回、访问 URL 仍用 `http://localhost:3000`（客户端自行回落 127.0.0.1）。
3. **接管链三条保留**（探测 `/api/version` 200 → 复用；否则 netstat 取 LISTENING PID → `taskkill /T /F` 后起；
   否则直接起），新增 **owned 语义**：只有本次壳自己 spawn 的服务在退出时才被杀。若 3000 上已有外部实例
   （`npm start` / 另一个 exe），壳**驻留托盘并在面板标「外部实例」**——这一点与旧 Go launcher
   「开浏览器即退出」不同，是有意的改进：面板本身对观察有用，且不该因启动壳就丢掉托盘。
4. **日志契约不变，日志窗口换实现**：同文件、同前缀格式、同样的启动截断；Go 的 Win32 自绘日志窗口
   （`logwindow_windows.go`）替换为 Electron 无边框窗口 `ui/logs.html`，读同一条时间线做尾随
   （打开时读尾部 + 1s 轮询增量）。托盘菜单的「显示日志窗口」与旧行为对齐（默认隐藏、可唤回）。
5. **托盘图标 = 品牌标记本身，颜色只编码健康度。**
   图形沿用 `dashboard-ui/gen-icon.py` 的品牌语法（橙色圆角方块 + 三根上升白柱 + 趋势线）；
   方块颜色 = 状态：品牌橙 `#D5742E`=运行、琥珀 `#F0A93F`=启动中、灰 `#8A857E`=已停止、红 `#F2585D`=启动失败。
   16px 尺寸去掉趋势线与柱上圆点（糊成一团），32px 全保留。
   **运行时栅格化**：纯模块按状态/尺寸画出 RGBA 位图（4× 超采样后 box 降采样抗锯齿），
   `nativeImage.createFromBitmap` 直接用；不做 Kaneo 式的 27 组合构建期 PNG 矩阵（那里是三层服务，
   四种状态建不出矩阵的必要性）。
6. **flyout 面板移植原型，不重新设计。** 签名元素仍是**管道四柱**（投递中 / 有回应 / 面试中 / Offer），
   柱高按当前在册行数对数缩放，点击跳 `/pipeline?tab=APPLIED` 等既有 query。
   色相分工写死：品牌橙只表示数据，绿/琥珀/红只表示服务健康，别处不出现彩色。
   面板不含「开机自启」开关（Go 无此能力，原型也未画）——不给假开关。
7. **渲染层零网络**：面板与日志窗口只通过 IPC 拿快照，HTTP 全部由主进程发。
   快照字段：`service{state,owned,url,pid,since,healthMs,version,sha,coreVersion,packaged}`、
   `pipeline{applied,responded,interview,offer,total}`、`followups{due,items[]}`、
   `runs{running,queued}`。
   数据源全部是现有接口：`/api/version`、`/api/tracker`（**一次全量**，本地按 `Status` 计数，不按状态打四枪）、
   `/api/followups`、`/api/active-runs`。节奏：服务健康 2s；业务数据 15s + 面板打开时立即刷一次。
8. **打包：copy Electron 运行时 + 改名 + `resedit` 嵌现有 `dashboard-ui/icon.ico`，不做 asar。**
   产物是目录 `career-tray/`（`CareerDashboardTray.exe` + `resources/app/{src,ui,assets,package.json}`），
   `.gitignore` 收录。locale 只留 `en-US` / `zh-CN`（实测 dist 367 MB，其中 locales 48 MB / 55 个文件）。
   `electron` 已是根 `devDependencies`（当前二进制未下载），打包脚本必须**先探测 `node_modules/electron/dist/electron.exe`**，
   缺失就带可执行命令退出，不许静默降级。
9. **单实例锁**：`app.requestSingleInstanceLock()`；第二次双击 exe = 开/关面板（不是第二个托盘图标）。
10. **明确非目标**：开机自启、多服务栈（本产品只有一个 node 服务，硬凑层数是假状态）、安装器、自动更新 UI。

## 被拒方案

- **A 方案：Go + WebView2 装这份 HTML**（否决）：改动面更小，但把 UI 锁进 Go 的 CGO/COM 绑定，
  面板的每次迭代都要碰 Go；且本机与 Kaneo 已验证的 Electron 路径可整段复用（定位、失焦、多屏、打包）。
  体积与冷启动的代价见「后果」，用户已知情选择 B。
- **electron-builder / 安装器**（否决）：只为一个托盘壳引入构建期二进制与 NSIS，与「免安装」形态冲突，
  且本机代理环境下构建期下载易失败（Kaneo 的 `pack.mjs` 正是为此不用它）。
- **保留 Go 原生菜单 + 另起一个 HTML 面板进程**（否决）：两套生命周期、两个退出入口，状态会分叉。
- **构建期预渲染托盘图标组合**（否决）：只有 4 种状态 × 2 个尺寸，运行时机算更快也更少文件；
  27 组合是 Kaneo 三层服务的产物，这里不需要。
- **面板直连 `localhost:3000` 的 API**（否决）：Electron 渲染层要与服务端共享 CORS/端口假设，
  且托盘图标的状态还得在主进程算——同一份状态在两处各算一次必然漂移。
- **新增 `/api/tray-summary` 聚合接口**（否决）：为托盘在 web 层加一个只服务一个客户的端点，
  要跟着 Next 打包、要自己的测试；四个既有接口 + 本地计数足够。
- **启动壳时发现外部实例就照旧退出**（否决）：面板因此永远用不了 dev 场景，且托盘消失后没有任何
  可观察入口；改为驻留 + 「外部实例」标记，退出不杀。
- **端口漂移找空闲端口**（再次否决，维持 ADR-0063）：会打断浏览器扩展的 3000–3040 探测并改变
  localStorage origin。

## 后果

- 正面：托盘图标成为一眼可读的健康指示；面板把「今天管道什么样、有没有跟进到期、有没有评估在跑、
  服务是死是活」放在一次点击里；UI 迭代从此是改 HTML/CSS，不碰 Go。
- 代价一（体积）：现状 9 MB exe + 142 MB 运行时 ≈ 150 MB；新形态是 142 MB 服务运行时 + ~320 MB
  Electron 运行时（367 MB 裁掉 48 MB locales 后）≈ **460 MB 量级**，涨约 3 倍。免安装、不写注册表、不装服务。
- 代价二（启动）：多一层运行时加载，托盘图标出现时间晚于旧的 9 MB exe；具体数值记入验收记录（工单 07），
  本 ADR 不预估。
- 代价三（平台）：壳只有 Windows 实现（Electron 跨平台，但定位/图标/打包脚本按 Windows 写）。
  旧 Go 代码有非 Windows stub，冻结后仅作参考。
- 已知边界：托盘图标颜色表达的是「服务 + 启动失败」这一件事，不表达管道健康；管道信息只在面板里。
- 回滚：`node dashboard-ui/build-dashboard-ui.mjs --shell=go` 重出旧 exe（Go 源码与单测都不删）；
  数据层零迁移（服务运行时布局、`launcher.log`、`.dashboard-runtime/` 全不变）。

### 验收实测（2026-10-21，见 [docs/tray-acceptance-20261021.md](../tray-acceptance-20261021.md)）

- 体积：`career-tray/` 目录 **320 MB**，主程序 `CareerDashboardTray.exe` **246 MB**（不是预估的 460 MB）。
- 启动：「exe 启动 → 服务就绪」实测 **3–7 s**（四次采样，差异来自文件缓存）。
- 与本文的偏离（验收时根据真机表现定下来，写回此处以免下次重新发明）：
  - 面板窗口宽 **404**（= 384 卡片 + 两侧 10px 透明阴影留白）；工单里写的 384 会把卡片右侧裁掉。
  - 四柱图柱高用纯 `log` 比例 + 6px 基线桩，不用工单里的 `0.62 + 0.38·log`（后者 64 vs 1 只差 5px）。
  - 新增两个调试开关 `--state=` / `--theme=`，只影响本进程，不接管端口、不写系统设置。
- 未覆盖：副屏 / 多 DPI 与「任务栏换到顶部」需要外接显示器或 Win10 任务栏，本机不具备；
  几何逻辑由 `tray-shell/tests/flyout-position.test.cjs` 的负坐标副屏与顶部锚点用例守着。

#### 面板弹出「先闪一下」的定调与解法（2026-10-21 追加）

验收后用户报「点托盘后面板先闪一下」。像素时间线（16ms 粒度）量到：窗口已可见但面板要 **183–222ms** 才画上去，
亮度按 21.7 → 68.8 → 84.2 → 118.8 → 152.4 → 188.8 → 224.8 等步长爬升 —— **整窗 alpha 淡入**。
逐项排除：DWM 过渡开关（`DWMWA_TRANSITIONS_FORCEDISABLED`）、`--disable-direct-composition`、
`--disable-backgrounding-occluded-windows`、`backgroundThrottling:false`、`transparent:false`、`showInactive()`、
CSS `fly-in`（全程 `finished`）均无效；屏外停靠代替 `hide()` 更差（677ms，屏外不参与合成）。

**只需要不调 `ShowWindow` 就没有淡入**：窗口在创建时以 alpha 0 + 鼠标穿透 `showInactive()` 一次，
之后收起 = `setOpacity(0)` + `setIgnoreMouseEvents(true)` + `setAlwaysOnTop(false)`，
打开 = 反序恢复再 `setOpacity(1)` + `focus()`。点击→画上 **343ms → 196ms**（剩余部分是本机派生进程的下限，真实点击不付这笔），
首帧即实心。鼠标穿透用 `WindowFromPoint` 断言（收起后命中底下别的进程窗口）。
代价：面板窗口常驻（不可见、穿透、不置顶），因此**禁止再改回 `hide()`**——
守卫在 `tray-shell/tests/flyout-park.test.cjs`，注入 `hide()` 会红。

## References

- 视觉定稿：`.scratch/tray-flyout/prototype.html`（四态 × 深浅主题，图标 16/32px 对照，数据来源标注）
- 参照实现：`D:\workspace\kaneo\.scratch\kaneo-tray\src\{main,services,proc,trayicon,flyout-position}.cjs`、
  `scripts/pack.mjs`（免安装打包 + resedit 嵌图标）、`tests/flyout-position.test.cjs`
- 现状实现：`dashboard-ui/launcher.go`（接管链/就绪等待/重启）、`platform_windows.go`（spawn 契约）、
  `logsink.go`（日志格式与截断）、`tray_windows.go`（菜单项）、`logwindow_windows.go`（将被替换）
- 品牌图标：`dashboard-ui/gen-icon.py`（橙色方块 + 三柱 + 趋势线）、`dashboard-ui/icon.ico`（打包嵌入源）
- 端口与接管：ADR-0063；日志与驻留：ADR-0066（含修订 2 的 GUI 子系统决议）
- 打包编排：`local/pack-launcher.mjs`、`docs/launcher-packaging.md`
- 数据接口：`web/src/app/api/{version,tracker,followups,active-runs}/route.ts`；
  面板跳转沿用 `/pipeline?tab={APPLIED,RESPONDED,INTERVIEW,OFFER}`（`pipeline-view.tsx` 既有 query）
- 状态口径：`templates/states.yml`（applied / responded / interview / offer）
- 工单：`.scratch/tray-electron-flyout/issues/01–07`
