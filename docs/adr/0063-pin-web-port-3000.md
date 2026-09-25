# ADR-0063: web 端口严格固定 3000——三 launcher 统一接管链，LOCK 机制废除

- **Status:** Accepted (2026-09-25)
- **Context:** 需求（2026-09-25，三轮 grilling 敲定）：把 dashboard 的 web 端口固定为 3000，杜绝端口漂移。动机与现状约束：

  1. **配置页一半状态存在 localStorage，而 localStorage 按 origin（协议+主机+端口）分区**：`career-ops:config` 里的 `scanSource`/`scanMax`/`applyBehavior` 等字段（`web/src/lib/saved-cli.ts` 一族）在端口变化后整体"看起来丢失"——这是用户痛点本源。服务端镜像 `~/.career-ops-web/config.json` 与端口无关，救不回浏览器侧字段。
  2. **三个 launcher 的端口策略互相漂移**：Go 启动器（`dashboard-ui/launcher.go`）在 3000-3040 挑第一个空闲口；`start-dashboard.ps1` 在 LOCK 失效时挑**完全随机**端口（可能漂出扩展探测区间，扩展直接失联）；`start-dashboard.js` 的 `pickFreePort` 是假实现（异步回调用在同步函数里，恒返回 3000，"歪打正着"不可依赖）。
  3. **浏览器扩展只探测 127.0.0.1:3000-3040**（`extension/background.js` `PORT_MIN..PORT_MAX`，`report-target-pure.js` 同区间粗判）——区间外端口对扩展不可见。固定 3000 天然落在区间内，探测逻辑无需收窄。
  4. **`start-web.cmd`（dev 入口）已经硬编码 3000 且无差别杀掉占用者**（tree-kill）——house 先例：接管语义是"杀任何占用进程"，不限 node。
  5. **LOCK 文件（`.dashboard-runtime/*/LOCK`）的原职责是"记住随机端口"**；端口固定后该职责消失，Go/ps1/js 三处 `readLock/writeLock/删除 LOCK` 代码路径变成纯遗产。
  6. **打包链**：`build-dashboard-ui.mjs` 第 7 步 `go build -ldflags -X main.cacheVersion=...` 产出 `career-dashboard-launcher.exe`；改 `launcher.go` 后必须重打包才对日常双击入口生效（重打包前先停运行中的旧实例——全局规则）。

- **Scope:** `dashboard-ui/launcher.go`（+`launcher_test.go`）、`dashboard-ui/start-dashboard.ps1`、`dashboard-ui/start-dashboard.js`、重打包产物 `career-dashboard-launcher.exe`、本 ADR。**不动**：`start-web.cmd`（已固定）、扩展端口探测（区间兼容固定口）、web 应用本体、绑定地址家规（`HOSTNAME=127.0.0.1` 绑定、`localhost` 访问，见 `_custom.md` 家规）。

## Decision

1. **端口常量 3000，绝不回退**：三个 launcher 一律 `PORT=3000`；任何路径（含托盘重启）都不存在"换端口再起"的分支。区间探测 3000-3040 与随机挑口逻辑整体删除。
2. **统一接管链**（三入口同一顺序）：
   - ① 探活 `http://localhost:3000/api/version`（200 即命中）→ **复用**：不杀任何东西，直接开浏览器（dev 与 standalone 一视同仁，谁 3000 活用谁的）；
   - ② 探活不中且 3000 有 LISTEN 占用 → **杀进程树**：`taskkill /PID <pid> /T /F`（对齐 `start-web.cmd` 口径，不限 node），等待端口释放（超时上限沿用各入口既有值）；
   - ③ 以 `PORT=3000`、`HOSTNAME=127.0.0.1` 启动 server；
   - ④ 杀不掉（权限不足）、杀完仍绑不上、或启动/就绪失败 → **报错退出**，文案带上占用进程 PID/映像名；错误渠道沿用各入口既有机制（Go/ps1 弹框、js 日志）。
3. **LOCK 机制废除**：删除 `readLock`/`writeLock`/`readPortFromLock`/`KillServerForPort` 的 LOCK 前置与各处 LOCK 清理代码；`.dashboard-runtime/*/LOCK` 残留文件随实现一并删除。"是否已有实例在跑"完全由探活承担。runtime 目录其余用途（node.exe、app/、icon.ico、tray-debug.log）不变。
4. **托盘「重启服务」走同一链路**：先杀自己拉起的 server，再从 ① 重新走接管链（端口恒为 3000，`restartServer` 的换端口逻辑删除）。Go 侧重启时若探活命中（自己的子进程还没死透）以"杀干净再起"为准，复用逻辑只属于冷启动路径。
5. **可测纯函数收口判定逻辑**（ADR-0055/0060 抽纯函数先例）：Go 侧把接管决策抽成不触 OS 的纯函数——输入 `{probeOK, listenerPID}`，输出 `{reuse | kill-then-start | error}`，进 `launcher_test.go`；ps1/js 无单测基建，以手工端到端验收覆盖三条路径（空闲→起 3000；假服务占 3000→杀后接管；真实例在跑→复用不互杀）。
6. **重打包属于本任务**：改完用 `build-dashboard-ui.mjs` 全量流程重打包 `career-dashboard-launcher.exe`（先停旧实例；打包需提权的既有坑按经验处理），产物按四判据核验（exe 大小/时间戳、`/api/version` 字段对齐、HEAD SHA 一致、runtime 目录清理）。
7. **`start-dashboard.js` 的假 `pickFreePort` 直接删除**而非修复：固定端口后该函数无职责，"歪打正着恒 3000"的实现连同 `net` 探测一起移除。

## Alternatives considered

- **优先 3000、区间内回退 3001-3040**（Go 现状语义推广到三入口）：扩展兼容保住了，但端口一漂 localStorage 照丢——原始痛点没解决，用户明确排除。
- **3000 被占直接报错、不杀进程**：最保守，但日常"双击重启"体验恶化（每次手动处理占用）；`start-web.cmd` 已有杀占用的 house 先例，统一后行为可预期。
- **只杀 node 进程**（既有 `KillServerForPort` 守卫）：对其它项目/IDE 占用 3000 无解，会退化成报错路径，违背"端口永远可预期"的初衷。
- **保留 LOCK 作为"实例已活"的缓存**：端口固定后它只剩探活的冗余前置；留着反而在锁文件残留（上次崩溃）时引入一次假复用判断，删。
- **扩展探测区间收窄为只探 3000**：探测更快，但改动扩展、偏离上游设计，且区间探测对固定口完全透明——收益趋近于零。
- **顺手修复 `career-dashboard.exe`（根目录旧二进制）的来源混淆**：该文件与 `career-dashboard-launcher.exe` 的新旧关系不在本决策树内，不碰（known gap）。

## Consequences

- 三入口行为收敛为一条接管链：任何"起不来"都停在报错并显示占用者，不再出现静默换口——配置页 localStorage origin 自此稳定。
- 代价一：3000 被其它项目长期占用时，career-ops 启动会将其终止。杀任何进程树的权限边界（系统进程/他人会话进程杀不掉）落入报错路径，无数据损坏风险，但有打断他项目的可能——用户显式选择。
- 代价二：dev（`next dev`）与 standalone 在同一端口上互斥复用，两者不再可能并行；探活无法区分身份，视为特性（谁的 3000 活用谁的）。
- `launcher.go` 的 `pickFreePort` 及"扩展只认 3000-3040"的注释论证、ps1 的 `PickFreePort`/`ReadPortFromLock`、js 的 `readPortFromLock`/`pickFreePort` 全部退役——历史论证以本 ADR 为准。
- `localhost` 与 `127.0.0.1` 混用仍是两个 localStorage 桶，本 ADR 不解决（家规已定展示用 localhost，属使用纪律）。
- 托盘「重启服务」语义微变：从"换端口重拉"变为"同口重拉"，重启后浏览器 URL 恒定。

## References

- `dashboard-ui/launcher.go`（`pickFreePort`/`readLock`/`httpAlive`/`restartServer`）、`dashboard-ui/start-dashboard.ps1`、`dashboard-ui/start-dashboard.js`、`dashboard-ui/build-dashboard-ui.mjs`、`start-web.cmd`（tree-kill 先例）、`extension/background.js`（`PORT_MIN..PORT_MAX`）。
- ADR-0050 / ADR-0055（扩展与 launcher 的端口探测链路、纯函数+单测口径先例）、ADR-0002 / ADR-0007（扩展↔web 端口约定的由来）。
- 实现工单：`.scratch/port-3000-fixed/issues/`（01 = Go launcher + 纯函数单测；02 = ps1/js launcher 对齐接管链；03 = 重打包 + 端到端三路径验收）。

## 落地状态（2026-09-25）

- **工单 01（Go）**：`launcher.go` 删 `pickFreePort`/`readLock`/`writeLock`，接管链 + `decideTakeover` 纯函数落地；`launcher_test.go` 改判纯函数表驱动，`go vet ./...` 与 `go test ./...` 全绿。
- **工单 02（脚本）**：`start-dashboard.ps1` 删随机口/`ReadPortFromLock`/LOCK，改 `ProbeAlive`+`KillPortOwner`（`taskkill /T /F` 任何占用者），补 `using System.Net;`（原 `WaitForServerReady` 亦缺，属既有潜在 bug），删死字段 `_running`，内嵌 C# 编译通过；`start-dashboard.js` 删假 `pickFreePort`/LOCK、`killNodeProcesses`→`killPortOwner`（加 `/T`），`node --check` 通过。
- **工单 03（重打包 + 验收）**：web 本体本次未改，采用**仅 launcher 重打包**（`go build -ldflags -X main.cacheVersion=976a776`，对齐现有 runtime 目录，避免整包 `next build` 的耗时与副作用），旧 exe 备份为 `career-dashboard-launcher.exe.bak-2026-09-25`。四判据之 SHA 对齐已实证：当前活实例 `/api/version` 返回 `200` 且 `sha=976a776`，与 exe 注入的 `cacheVersion`、runtime 目录三者一致；「复用」路径经真实实例触发验证。
- **待用户执行（GUI 侧，无法自动化）**：杀后接管、冷启动起 3000、托盘重启三条路径的浏览器目视验收（见工单 03 末条）。
