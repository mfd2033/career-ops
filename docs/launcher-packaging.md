# career-ops 托盘壳（Electron）打包编排

<!-- 独立文档：不自动加载进每会话上下文，打包时才按需 Read。
     下方是完整编排；`modes/_custom.md` 只保留一短索引（关键常量）。
     改此文件前先同步更新 _custom.md 索引中的常量，避免两处漂移。 -->

> **2026-10-21 起壳换了（ADR-0086）**：托盘/日志窗口从 Go + fyne 换成 Electron 主进程壳
> （`tray-shell/`），产物从「仓库根 9 MB exe」变成「仓库根 `career-tray/` 目录」。
> Go 源码（`dashboard-ui/*.go`）冻结保留，`--shell=go` 仍可产出旧 exe 作回滚。
> 本文档描述的是**当前默认路径**；Go 专属的坑（APPDATA / GOPROXY / go-winres）集中标在「回滚」一节。

- **一键入口（首选）**：`node local/pack-launcher.mjs`
  - 它是下方第 0/1/2/3 步编排的**可执行版本**；**本文件仍是权威描述**——语义有分歧以本文件为准，改任一侧时两边一起改。
  - 脚本住 gitignored 的 `local/`（ADR-0022 的 fork-local 层）：不进仓库、不与上游 merge 冲突。
  - 为什么是 Node 而不是 PowerShell 脚本：本编排要求「命令必须与所在 shell 匹配」，而本机 shell 会在 PowerShell 与 cmd 之间回落。脚本用 `child_process` + `shell: false` 直传 argv，绕开引号与插值整类问题。
  - 开关：`--no-start`（只打包不启动）/ `--keep-next`（不删 `web/.next`，也就不碰 dev server）/ `--keep-runtime`（保留旧 runtime 目录）/ `--dev-port N`（默认 3101，与 AGENTS.md 的 dev-web 约定一致）/ `--fresh-winres`（仅 `--shell=go` 回滚路径有意义）。`--help` 打印同一份清单。
  - 它替你兜住的四件事：① 停旧壳（含只杀 `career-tray/` 下的 `electron.exe`，不误伤别的 Electron 应用）；② 清 `.next` 前先停 dev server（**按命令行识别**：`dev-web.mjs` 或 `next dev` + 本仓路径，任何端口都命中；`--dev-port` 只是命令行特征都不匹配时的附加兜底——按端口找人靠不住，端口一换就落空，2026-09-25 与 2026-10-30 两次 ENOTEMPTY 都是这么来的）；③ 打包后**结构自检**（`version.json` 的 cacheVersion 与 `build-info.json` 一致、locales 恰好 2 个、`default_app.asar` 已删）；④ 启动后按 `/api/version` 四判据自证，再清旧 runtime 目录。

- **执行约定（工具 / 位置 / 超时）**
  - **工具**：首选 Windows PowerShell。PowerShell 失效（退出码 1 且无输出，或退出码 0 但拿不到 stdout）时整体转 Git Bash 调同等命令（`tasklist` / `netstat -ano` / `taskkill`）。
  - **位置**：文件系统/网络操作可在沙箱内；进程管理与拉起长驻进程需沙箱外。
  - **工作目录**：仓库根，用工具的工作目录参数设定，不要 `cd /d/...`。
  - **前置环境**：`node -v` ≥ 22（`next.config.mjs` 依赖 `import.meta.dirname`）、`web/node_modules` 已装、`node_modules/electron/dist/electron.exe` 存在、`node_modules/resedit` 已装。**默认路径不需要 Go**。
  - 首次准备 Electron 二进制（代理环境必须给镜像，否则 `fetch failed`）：
    ```powershell
    $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js
    npm i -D resedit
    ```

- **第 0 步 打包前置（硬性）**
  - 0.1 **git 状态确认**：`git rev-parse --short HEAD` → 7 位短 sha（cacheVersion 基础）；`git status --porcelain` → 空 = `{sha}`，非空 = `{sha}-dirty`。想要干净版本号先 commit。
  - 0.2 **停止旧实例**
    - `taskkill /F /IM CareerDashboardTray.exe /T`（`/T` 必须，否则 node 子进程残留；Electron 是一组同名进程，主/GPU/渲染/工具都会被带走）。
    - 另有一个 `electron.exe`（开发态 `npm run tray`）时：只杀 **exe 路径在 `career-tray/` 下**的那些。脚本用 CIM 查 `ExecutablePath` 过滤后按 PID 杀；CIM 不可用就跳过，交给端口兜底。
    - 端口兜底：`Get-NetTCPConnection -LocalPort 3000 -State Listen` 取 PID → `taskkill /F /PID <pid>`，确认无 Listen 记录再继续。
  - 0.3 **为什么必须先停**：`build-dashboard-ui.mjs` 第 5c 步会先 `rmSync` 再重建 `.dashboard-runtime\v{cacheVersion}\`。重打同版本时 cacheVersion 相同 → 旧实例正在用的 runtime 目录被直接删：Windows 下文件被占用 → 脚本抛错；未抛错则旧实例静默失效。
  - 0.4 **环境清理**：`web/node_modules` 缺失才 `npm install`（registry 已指 npmmirror）；先按命令行停掉本仓 dev server（见上一条 ②），再删 `web/.next`（删不掉时脚本会报占用并给下一步，不再裸抛 ENOTEMPTY）。冷删可能要 2 分钟以上。

- **第 1 步 打包（一步到位）**
  - 1.1 **主命令**：`node dashboard-ui/build-dashboard-ui.mjs`（默认 `--shell=electron`）
    - 预期结果：退出码 0；仓库根出现 `career-tray/`（`CareerDashboardTray.exe` + `resources/app` + 裁过的 `locales`）；`.dashboard-runtime\v{cacheVersion}\` 重建；控制台打印 exe 路径、`cacheVersion`、locales 清单与总体积（≈320 MB）。
    - 成功判据：新 `career-tray/CareerDashboardTray.exe` 存在、无 `Error:`；若报 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`，追加豁免前缀 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 重跑（只豁免 Next 自身缓存清理）。
    - 工具：Shell · 位置：沙箱内 · 超时：**900000ms（15 分钟）** · 前台等待，禁止后台跨轮。
    - 耗时构成：`npm run build` 2–6 分钟（冷构建取上限）＋ 拷 Electron dist 与裁 locale 约 1 分钟 ＋ resedit 嵌图标数秒。
  - 1.2 **脚本内部流水线**（卡死排查用）
    1. `web/` 下 `npm run build`（`WEB_STANDALONE=1` → `.next/standalone`）
    2. 补拷 `.next/static`、清理 traced dev junk（src/tests/日志/配置）
    3. 干净 standalone tree → `dashboard-ui/app`
    4. 拷贝当前 node 二进制 → `dashboard-ui/node.exe`
    5. 写 `app/build-info.json`（sha / builtAt / cacheVersion / coreVersion）
    6. 预生成 `.dashboard-runtime\v{cacheVersion}\`
    7. `tray-shell/scripts/pack.mjs`：copy Electron dist → `career-tray/` → `electron.exe` 改名 `CareerDashboardTray.exe` → 删 `resources/default_app.asar` → 拷 `tray-shell/{package.json,src,ui}` 到 `resources/app/` → 写 `version.json` → 裁 locales 到 `en-US`/`zh-CN` → `resedit` 嵌 `dashboard-ui/icon.ico`
    8. 打印产物路径、`cacheVersion`、locales、总体积
  - 1.3 **回滚路径**：`node dashboard-ui/build-dashboard-ui.mjs --shell=go`
    - 产出仓库根 `career-dashboard-launcher.exe`（约 9 MB，PE Subsystem 校验为 GUI(2)，否则拒绝产出）。
    - 该路径才需要 `go version` ≥ 1.24 与 go-winres；此时才适用旧的两个坑：**APPDATA 空陷阱**（沙箱内 `APPDATA` 常为空 → go 读不到 `%APPDATA%\go\env`，回退官方源 Bad Gateway；须显式注入 `APPDATA=$env:USERPROFILE\AppData\Roaming`）与 **GOPROXY**（`go env -w GOPROXY=https://goproxy.cn,direct`，或命令行前缀注入，否则 go-winres 安装可卡 10 分钟）。

- **第 2 步 启动并验证**
  - 2.1 **启动**：`career-tray/CareerDashboardTray.exe`（双击或沙箱外拉起）
    - **进程存活观察点**：`tasklist /FI "IMAGENAME eq CareerDashboardTray.exe"` —— 出现即视为壳已起（Electron 会同时有一组子进程，属正常）。
    - **窗口预期**：不出现任何控制台窗口；**面板默认不弹出**（左键点托盘才展开）；日志窗口默认不存在（右键「显示日志窗口」才创建）。
    - 预期结果：命令立即返回；约 60s 内服务就绪，默认浏览器打开 `http://localhost:3000`。
  - 2.2 **验证**：`Invoke-RestMethod http://localhost:3000/api/version`
    - 预期：HTTP 200，`{"sha":"{短sha}","packaged":true,...}` → 成功。
    - 失败判据：`packaged:false` 或 sha 不符 = 服务的是工作树而非打包构建（查 `.dashboard-runtime` 权限、`career-tray/` 是否被杀软占用）；连接失败/超时 = 见 2.3。
  - 2.3 **启动失败排查**：端口被占 → 回 0.2 清端口（壳会自己杀无应答的占用者，杀不掉就是红态）；启动即崩 → `.dashboard-runtime\v{cacheVersion}` 权限、node.exe 完整性；死亡原因看 `.career-ops-web/launcher.log`（首行必是 `[hh:mm:ss] [launcher] launcher 启动：…`）。
  - 2.4 **托盘与面板验收**
    - 左键托盘 → 面板贴图标弹出（窗口 404 = 384 卡片 + 两侧 10px 阴影留白，高度贴内容）；点别处/再点图标/`Esc` → 收起。
    - 右键托盘 → 原生菜单四项：打开仪表盘 / 显示日志窗口 / 重启服务 / 退出。
    - 「显示日志窗口」→ 无边框窗口出现在当前屏中央（600×520），关掉再点仍能唤回（不新建第二个）。
    - 托盘图标颜色 = 健康度：橙=运行、琥珀（呼吸）=启动中、灰=已停止、红=启动失败。
    - 完整逐条实测与证据见 [docs/tray-acceptance-20261021.md](tray-acceptance-20261021.md)。

- **第 3 步 旧 runtime 目录清理（可选维护）**
  - `Remove-Item .dashboard-runtime\v{旧sha} -Recurse -Force`，只保留当前版本目录。
  - **顺序硬性：先停旧实例 → 再删旧 dir → 再打包**，绝不能先删后停。

- **产物结构**
  ```
  career-tray/                      ← 整个目录就是一个自包含的托盘壳，可整体拷走
    CareerDashboardTray.exe         ← Electron 主进程（改名自 electron.exe，图标已嵌入）
    resources/app/                  ← 应用本体（不是 asar，便于排障与热改面板）
      package.json                  ← main = src/main.cjs
      version.json                  ← { cacheVersion, sha, builtAt }（打包注入，运行时据此选 runtime 目录）
      src/{main,service,proc,runtime,logger,snapshot,state,tray-icon,flyout-position,preload}.cjs
      ui/{panel.html,panel.js,theme.css,logs.html,logs.js,logs.css}
    locales/                        ← 只留 en-US.pak / zh-CN.pak（其余 53 个已裁）
    *.dll / *.pak / vk_swiftshader  ← Electron 运行时，别动（删 dx*/swiftshader 会让无 GPU 机器黑屏）
  ```
  - 可删：`career-tray/`（重打包会重建）、`.dashboard-runtime/`（服务运行时缓存，重打包重建）。
  - 不可删：`data/`、`reports/`、`config/`、`cv.md` —— 用户数据，与壳无关。

- **体积与版本机制**
  - 现状：9 MB exe + 142 MB 服务运行时 ≈ 150 MB；新形态 142 MB + ~320 MB Electron ≈ **460 MB**，涨约 3 倍（ADR-0086「后果」已记录，用户知情选择）。locales 从 48 MB 裁到约 2 MB 是唯一做过的裁剪。
  - `cacheVersion = git短SHA`；工作树有未提交改动时追加 `-dirty`。它同时写进 `build-info.json`（web 侧 `/api/version` 读）与 `resources/app/version.json`（壳读），两处必须同源——`pack-launcher.mjs` 会自检。
  - **关键注意：不要手工改 `version.json`**。cacheVersion 与目录名绑定；写错会让壳去取旧的 `.dashboard-runtime` 目录，症状是「重打之后页面还是上一版」。

- **Turbopack 警告（已知，非本次改动引入）**：web 前端对 `career-ops.ts`、各 `route.ts` 等做动态文件系统访问，触发约 15 条 full-project-trace 警告；后续可改为静态作用域路径或加 `turbopackIgnore` 注释消除。
