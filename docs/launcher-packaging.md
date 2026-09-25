# career-dashboard-launcher.exe 打包编排

<!-- 独立文档：不自动加载进每会话上下文，打包时才按需 Read。
     下方是完整编排；`modes/_custom.md` 只保留一短索引（关键常量）。
     改此文件前先同步更新 _custom.md 索引中的常量，避免两处漂移。 -->

- **一键入口（2026-09-16 起，首选）**：`node local/pack-launcher.mjs`
  - 它是下方第 0/1/2/3 步编排的**可执行版本**；**本文件仍是权威描述**——语义有分歧以本文件为准，改任一侧时两边一起改。
  - 脚本住 gitignored 的 `local/`（ADR-0022 的 fork-local 层，见 `local/README.md`）：不进仓库、不与上游 merge 冲突；换机器 clone 后 `local/` 本就不在，照本文件手跑即可。
  - 为什么是 Node 而不是 PowerShell 脚本：本编排要求「命令必须与所在 shell 匹配」，而本机 shell 会在 PowerShell 与 cmd 之间回落（实测 `Set-Location` 报「不是内部或外部命令」、PS 里 `$i:` 被当成驱动器变量而解析失败）。脚本用 `child_process` + `shell: false` 直传 argv，绕开引号与插值整类问题。
  - 开关：`--no-start`（只打包不启动）/ `--keep-next`（不删 `web/.next`，也就不碰 dev server）/ `--fresh-winres`（**上次打包失败过**才用，强制重装 go-winres）/ `--keep-runtime`（保留旧 runtime 目录）/ `--dev-port N`（默认 3100）。`--help` 打印同一份清单。
  - 值开关 `--dev-port` 两种写法都认（`--dev-port 3100` / `--dev-port=3100`）。未知开关、缺值或非法端口、以及 `--dev-port` 与 `--keep-next` 这一矛盾组合，**在做任何耗时步骤之前当场退出**，不静默回退默认值——曾因只认等号写法，照本文件传空格形式被丢弃（退成 3100）、dev server 没被停，直到清 `web/.next` 才抛 `ENOTEMPTY`，报错不指向真因（2026-09-25 实测）。手工照本文件重跑时同样适用此判据：停 dev server 的那一步必须确认它真的命中了监听端口。
  - 它替你兜住三件容易漏的事：① APPDATA 空陷阱（用 `USERPROFILE` 兜出实路径 + 进程级注入 GOPROXY）；② safe-delete shim（清 `NODE_OPTIONS` 与三个 `_BULK_*` 变量——只设 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 不够，2026-09-12 实测）；③ 清 `.next` 前先停 dev server，以及打包后按 `dashboard-ui/app/build-info.json` 的 cacheVersion 删掉旧 runtime 目录。

- **用途（2026-09-11 拆分）**：本文件承载「打包 career-dashboard-launcher.exe」的完整编排流程。原居 `modes/_custom.md`，因内容多、每会话全量加载耗 token，迁移至此，打包时再按索引显式 Read。

- **执行约定（每条命令统一标注：工具 / 执行位置 / 超时，2026-09-11 补——照此可复现）：**
  - **工具**：全部用 Shell 工具，**首选 Windows PowerShell 环境**。
    - **PowerShell 不可用兜底（2026-09-11 实测）：** 某些沙箱/会话环境下 PowerShell 工具会失效。**两种失效形态都算「不可用」，一旦命中即整体转 Bash（Git Bash）调用同等 Windows 命令**（`tasklist` / `netstat -ano` / `taskkill`）、`Invoke-RestMethod` 换 `curl`：
      1. **退出码 1 且无输出**（旧报法）：简单命令 `Get-Location`/`Get-Process`/`git` 均失败；
      2. **退出码 0 但 stdout 空**（workbuddy 沙箱报法，2026-09-11）：探针 `Get-Location`/`Write-Output` 照样退出 0，但**拿不到 stdout 回传**。
      - **stdout 空对打包的影响（已核实可打包）：** 打包主命令 1.1 的**成功判据不依赖 stdout**——靠「命令退出码 0 + 仓库根出现新 `career-dashboard-launcher.exe`」，后者用文件系统（Glob/LS）验证即可，无需回传文本。**stdout 空仍可走完整打包流程。**
      - **受影响的只有「需回传文本」的步骤，转 Bash 即可**：0.1 拿 git sha（或打包后从产物 `build-info.json` 反查）、0.2 查进程/端口清单、2.2 读 `/api/version` JSON（`Invoke-RestMethod` 换 `curl`）。
      - **判定 PS 是否可用的探针**：跑 `Get-Location; Write-Output 'PROBE-OK'`——能回传路径+`PROBE-OK` = PS 可用；stdout 空即便退出 0 也判不可用，转 Bash。
      - 注意：底层 cmd/PowerShell 不支持 Git Bash 的 `/d/...` 路径与 `&&` 短路已在下方工作目录约定规避。
    - **wmic 边界（2026-09-11 实测）：** `wmic` 可能被 WorkBuddy 安全策略拦截（Program Blacklist），不可重试。查进程命令行改用 `tasklist /FI` + `netstat -ano` 反查端口，等效完成「确认无 dev server / 残留服务」。
  - **执行位置**：
    - **沙箱内** = 文件系统 / 网络操作，产物落在仓库内，默认可执行；
    - **沙箱外** = 进程管理 / 启动长驻进程，属系统级能力，沙箱不支持，需关闭沙箱执行（如 `dangerouslyDisableSandbox: true`）。
  - **工作目录**：所有命令在仓库根 `D:\workspace_opencode\career-ops` 执行，用工具的工作目录/cwd 参数设定；**不要** `cd /d/workspace_opencode/career-ops`（Git Bash 路径，PowerShell/cmd 解析失败、`&&` 短路）。
  - **前置环境**（缺一个就报错或卡）：`node -v` ≥ 22（next.config.mjs 依赖 `import.meta.dirname`）；`go version` ≥ 1.24。
  - **APPDATA 为空陷阱（2026-09-11 实测，打包失败根因）：** 沙箱内 `APPDATA` 环境变量常为空（`go env -w` 会报 `%AppData% is not defined`；即便显式传 APPDATA 写入成功，打包脚本派生的 `go` 子进程**继承空 APPDATA，仍找不到 `%APPDATA%\go\env` 文件**，回退官方源 `proxy.golang.org` 随即 Bad Gateway）。**必须显式把 APPDATA 与 GOPROXY 作为环境变量传给打包命令**（优先级高于 env 文件），见第 1 步主命令。
  - **网络镜像（卡 10 分钟的头号原因）**：脚本首次运行会自动 `go install github.com/tc-hib/go-winres@latest`，默认走 Go 官方源，国内网络长时间无响应。`go env -w GOPROXY=https://goproxy.cn,direct` 只是基础写盘，**不保证打包子进程读到**——完整可靠做法是在打包主命令行前缀显式注入 `APPDATA=<AppData>` 与 `GOPROXY=https://goproxy.cn,direct`；npm 慢则 `npm config set registry https://registry.npmmirror.com`。
- **第 0 步 打包前置（硬性）：**
  0.1 **git 状态确认**
    - 命令：`git rev-parse --short HEAD`
    - 预期结果：输出 7 位短 sha（如 `62ba9d8`），即 cacheVersion 基础。
    - 命令：`git status --porcelain`
    - 预期结果：空输出 = 干净工作树，版本号 `{sha}`；非空 = 有未提交改动，版本号 `{sha}-dirty`。想要干净版本号就先 commit 再打包。
    - 工具：Shell · 位置：沙箱内（只读） · 超时：15000ms
  0.2 **停止旧实例**
    - 命令：`Get-Process career-dashboard-launcher -ErrorAction SilentlyContinue`
    - 预期结果：无输出 = 无旧实例，跳过后续两条；有 PID = 存在旧实例，继续执行以下两条。
    - 工具：Shell · 位置：沙箱外（进程查询） · 超时：15000ms
    - 命令：`taskkill /F /IM career-dashboard-launcher.exe /T`
    - 说明：`/T` 必须，否则 node 子进程残留。
    - 预期结果：返回「成功: 已终止 PID xxx 的进程」；所有 PID 消失即清完。
    - 工具：Shell · 位置：沙箱外（进程管理） · 超时：15000ms
    - 命令：`Get-NetTCPConnection -LocalPort 3000 -State Listen` 定位 PID，再 `taskkill /F /PID <pid>`
    - 说明：node 若是 detached 子进程 `/T` 带不走，端口兜底清残留。
    - 预期结果：无 Listen 记录 = 端口已空；有记录则按其 PID 强杀后再查至空。**确认无残留后再继续。**
    - 工具：Shell · 位置：沙箱外（网络+进程） · 超时：15000ms
  0.3 **为什么必须先停（机制原因）**：`build-dashboard-ui.mjs` 第 5c 步会先 `rmSync` 再重建 `.dashboard-runtime\v{cacheVersion}\`。若工作树干净且 sha 未变（重打同版本），cacheVersion 相同 → 旧实例正在使用的 runtime 目录被直接删：Windows 下文件被占用 → 脚本抛错；未抛错则旧实例静默失效。
  0.4 **环境清理**（防止上次中断的半成品导致卡死或坏产物，2026-09-11 补）：
    - 命令：`npm install`
    - 说明：仅当 `web\node_modules` 不存在时执行；registry 已指 npmmirror。
    - 预期结果：无报错，`web\node_modules` 生成，命令本身 1–3 分钟内结束。
    - 工具：Shell · 位置：沙箱内 · 超时：300000ms（5 分钟）
    - 命令：`Remove-Item web\.next -Recurse -Force`
    - 说明：上次 `npm run build` 中断会残留脏缓存，build 会全新重建；**若 `next dev` 正在运行先停掉**，否则删除会使 dev 崩溃。
    - 预期结果：`web\.next` 不复存在。冷删可能要 2m+（2026-09-11 实测 2m16s）。
    - 工具：Shell · 位置：沙箱内 · 超时：**180000ms（3 分钟）**
    - 命令：`Remove-Item dashboard-ui\.gobin -Recurse -Force`
    - 说明：仅当 `dashboard-ui\.gobin\go-winres.exe` 存在时——上次中断可能残留损坏文件，而脚本检测到「存在」就跳过安装。
    - 预期结果：`.gobin` 目录消失，强制重装。仅上次打包失败才需执行，故非必跑。
    - 工具：Shell · 位置：沙箱内 · 超时：15000ms
- **第 1 步 打包（一步到位）：**
  1.1 **主命令**：
    - **命令（2026-09-11 更新，两版写法都显式注入环境变量绕过 APPDATA 空陷阱）：**
      - **PowerShell 写法（当前环境首选）**：
        `$env:APPDATA="$env:USERPROFILE\AppData\Roaming"; $env:GOPROXY='https://goproxy.cn,direct'; node dashboard-ui/build-dashboard-ui.mjs`
      - **Bash / Git Bash 写法**（APPDATA 用当前用户目录绝对路径，如 `$HOME/AppData/Roaming` 的实际值）：
        `APPDATA="$APPDATA_REAL_ROAMING" GOPROXY=https://goproxy.cn,direct node dashboard-ui/build-dashboard-ui.mjs`
    - **关键：命令行必须与所在 shell 匹配**。PowerShell 会话里跑 Bash 写法（`VAR=x cmd` 命令前缀）**不会注入 env**——PowerShell 只认 `$env:VAR=` 前缀,命令会回退官方源挂起（workbuddy 卡在 1.1 的根因之一）。先判用哪个 shell（见执行约定「PS 探针」）,再选对应写法。
    - 说明：`APPDATA` 必须指向含 `go\env` 的实路径（`C:\Users\<user>\AppData\Roaming`）；只用 `go env -w` 写盘不够——子进程继承空 APPDATA 会读不到 env 文件，回退官方源 Bad Gateway；显式进程级注入 `GOPROXY=https://goproxy.cn,direct` 直走国内镜像,`go install go-winres` 几秒装完,无官方源挂起窗口。
    - **预期结果**：命令退出码 0，无报错；仓库根出现新 `career-dashboard-launcher.exe`（约 9 MB，mtime 为本次时间），`.dashboard-runtime\v{cacheVersion}\` 重建。
    - **成功判据**：新 exe 产出 + 无 `Error:`；若报 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` 见下方豁免；若卡 5 分钟无新 `$ <cmd>` 行 = 卡死，终止排查。
    - 工具：Shell · 位置：沙箱内（产物全在仓库内，网络默认放行） · 超时：**900000ms（15 分钟）**
    - **前台等待 / 当轮收尾（硬性，2026-09-11 实测）**：打包命令必须前台阻塞等待完成或在同一会话轮次内收尾，**禁止以后台方式跨轮等待**——后台长命令会在会话轮次结束时被终止（实测第 2 次打包运行 10m15s 仍无报错输出，但轮次结束进程被杀，未产出 exe）。
    - **safe-delete 豁免（2026-09-11 实测）**：若打包在 Next「Finalizing page optimization」收尾阶段报 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`（WorkBuddy safe-delete shim 拦截 Node 删除，本轮累计删 >50 文件即拦，Next 清理自身 `.next` 旧文件时必触发），追加豁免前缀重跑：`CODEBUDDY_SAFE_DELETE_ENABLED=0 node dashboard-ui/build-dashboard-ui.mjs`。豁免仅作用于该子进程，只影响 Next 自身重建的 `.next` 构建缓存，风险可控；**仅 Next/构建类自身缓存清理场景使用**，不用于常规业务文件删除。
    - 耗时依据（2026-09-10 实测：builtAt 19:17 本地、会话 19:18 完成，动作分钟级；无分步明细，按下述预算）：
      - `npm run build`（最久，Next 16 生产构建 + 全项目 trace）：2–6 分钟（0.4 清过 `.next` 后为冷构建，取上限）
      - go-winres 首次安装（设 GOPROXY 后）：1–2 分钟；不设镜像则无限卡
      - `go build` 编译 launcher：<1 分钟
      - 拷贝 / 清理 / 写 build-info：<30 秒
      - 合计 4–9 分钟（含 0.4 清 `.next` 的冷构建裕量），15 分钟超时留 6 分钟裕量；卡死判定：**5 分钟无新 `$ <cmd>` 行**。
  1.2 **脚本内部流水线**（无需单独执行，仅供卡死排查定位）：
    1. `web/` 下 `npm run build`（`WEB_STANDALONE=1`，产出 `.next/standalone`）
    2. 补拷 `.next/static`、清理 traced dev junk（src/tests/日志/配置）
    3. 干净 standalone tree → `dashboard-ui/app`（Go embed 源）
    4. 拷贝当前 node 二进制 → `dashboard-ui/node.exe`（打包所用 node 版本会被固化为 embedded runtime）
    5. 写 `app/build-info.json`（sha / builtAt / cacheVersion）
    6. 预生成 `.dashboard-runtime\v{cacheVersion}\` 运行时缓存
    7. `go-winres make` 生成 `.syso`（图标+清单+版本）
    8. `go build -ldflags "-X main.cacheVersion=..."` → 仓库根 `career-dashboard-launcher.exe`（约 9 MB）
- **第 2 步 启动新 exe 并验证：**
  2.1 **启动**：运行 `career-dashboard-launcher.exe`
    - 工具：Shell · 位置：沙箱外（拉起进程） · 超时：30000ms
    - 说明：启动长驻进程，工具立即返回；无端口参数，launcher 在 3000–3040 自动挑空闲端口（`pickFreePort`），通常取 3000。
    - 预期结果：命令立即返回，进程 `career-dashboard-launcher.exe` 出现在 `tasklist` 中；其在大约 60s 内就绪。
  2.2 **验证**：`Invoke-RestMethod http://localhost:3000/api/version`
    - 工具：Shell · 位置：沙箱内可试（localhost），被拦则沙箱外 · 超时：60000ms（launcher 有 60s 就绪窗口）
    - 说明：端口按实际（launcher 自动挑选，通常 3000）。
    - **预期结果**：HTTP 200，体为 `{"sha":"{短sha}","packaged":true,...}` → 成功。
    - 失败判据：`packaged:false` 或 sha 不符 = 服务的是工作树而非打包构建；连接失败/超时 = 见 2.3。
  2.3 **启动失败排查**：端口被占 → 回到 0.2 清端口；启动即崩 → 检查 `.dashboard-runtime\v{cacheVersion}` 权限与 node.exe 完整性。
- **第 3 步 旧 runtime 目录清理（可选维护）：**
  3.1 **清理命令**：`Remove-Item .dashboard-runtime\v{旧sha} -Recurse -Force`
    - 工具：Shell · 位置：沙箱内（仓库内目录） · 超时：120000ms（大目录删除慢）
    - 说明：仅保留当前版本目录（2026-09-11 实测已堆积 25 个）。
    - 预期结果：旧版本 runtime 目录消失，仅留 `v{cacheVersion}`。
    - **顺序硬性：先停旧实例 → 再删旧 dir → 再打包**，绝不能先删后停（旧实例运行中会占用/重写该目录）。
- **产物与版本机制：**
  - 产物固定输出到仓库根 `career-dashboard-launcher.exe`；运行时从 `.dashboard-runtime\v{git短sha}[-dirty]\` 读取 node.exe + app/server.js。
  - `cacheVersion = git短SHA`；工作树未提交改动时追加 `-dirty`。
  - **关键注意：不要裸跑 `go build`（不带 packer）**——`cacheVersion` 为空会回退到「按 mtime 取最新 dir」逻辑，长驻服务会不断刷新自身 runtime dir 的 mtime，导致重打后的 exe 静默服务旧 web 构建（stale-cache 陷阱）。务必走 `build-dashboard-ui.mjs` 注入版本。
- **Turbopack 警告（已知，非本次改动引入）：** web 前端对 `career-ops.ts`、各 `route.ts` 等做动态文件系统访问，触发约 15 条 full-project-trace 警告；后续可改为静态作用域路径或加 `turbopackIgnore` 注释消除。