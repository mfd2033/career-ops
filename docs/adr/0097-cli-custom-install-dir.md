# ADR-0097: 未检测到的 CLI 支持指定安装目录并就地测试

- **Status:** Accepted (2026-11-03)
- **Context:** 配置页「AI 引擎 → 使用本机已装的 CLI」只在 PATH、共享搜索目录、各引擎自己的 `binDirs`/`fallbackDirs`（ADR-0052/0053）里找二进制。找不到就落进「未安装」分组——那是个 `disabled` 的 `<optgroup>` + 一串安装链接，用户手里明明装着却只能重装或自己改 PATH。真实场景：绿色版/便携版解压在 `D:\tools\xxx\`、装在非标准盘符、用 scoop/自定义 npm 前缀、或企业内网禁装到默认目录。此时「换个安装位置」是这个工具唯一的出路，而界面只给「去官网下载」。
  另一个同等重要的问题：任何「检测不到 → 用户填路径 → 直接用」的捷径都会把一次拼写错误变成一个**静默失败的派发**（`spawn ... ENOENT`，报告不落盘，用户只看到评估没反应）。所以「能用验证代替相信」是这条需求的一半。
- **Scope:** `web/src/lib/cli-dirs.mjs`（新增，纯函数）、`web/src/lib/pick-dir.mjs`（新增）、`web/src/lib/app-config.ts`、`web/src/lib/clis.ts`、`web/src/app/api/config/route.ts`、`web/src/app/api/clis/verify/route.ts`（新增）、`web/src/app/api/clis/pick-dir/route.ts`（新增）、`web/src/components/config-form.tsx`、`web/src/lib/saved-cli.ts`、`web/src/lib/i18n/clusters/config.ts`、测试。**不动**：`KNOWN` 引擎清单与各自 `binDirs`（ADR-0052/0053 的既定事实）、评分逻辑、派发/权限模型（ADR-0094 的「不得自我提权」不变）。

## Decision

1. **目录属于「用户对某台机器的判断」，落服务端配置而不是 localStorage。** 评估是 headless CLI 子进程派发的，读不到浏览器存储（ADR-0004 D3，`unknownEmployer`/`concurrencyPool` 同一条理由）。新增 `AppConfig.cliDirs: Record<引擎 id, 安装目录>`，持久化在 `~/.career-ops-web/config.json`。`/api/config` 的 `SAFE_KEYS` 显式收这一个键，写入前过纯函数清洗。
2. **用户指定的目录优先级最高**，其后才是 PATH/共享目录、引擎自己的 `binDirs`、`fallbackDirs`。ADR-0052 决议「PATH 优先于 vendor 目录」约束的是**自动发现**之间的顺序；用户显式指定是一次覆盖，必须真的覆盖——否则「我改了目录但用的还是 PATH 里那个」是这个功能最容易出的谎。指定目录里找不到时**不短路**，继续走原有的自动链路（删掉的目录不该让一个本来能用的引擎变成不可用）。
3. **检测与派发共用同一条解析路径。** 目录只在 `dirsFor()` 里前插，`findBinFor()` 仍是唯一入口，`detectClis()` 与 `resolveCli(id)` 都经过它——ADR-0052 已立的规矩：「配置页说已安装」与「派发能 spawn」必须是同一个事实。检测结果新增 `pathSource`（`custom` = 命中的二进制确实来自指定目录），让界面能回答「这次用的是哪一个」，而不是只显示路径让用户猜。
4. **检测缓存按目录签名失效，不靠调用方记得刷新。** `detectClisCached()` 原先只在 `refresh=1` 时重算；现在把当前 `cliDirs` 的签名一并记住，签名变了自动重算。理由：写目录的入口（配置页保存）与读目录的入口（`/api/clis`）是两条路由，靠「保存后再调一次 recheck」是把正确性押在前端记性上。
5. **测试按钮是只读探针，不是写路径。** 新增 `POST /api/clis/verify`（body `{cliId, dir}`）：归一化目录 → 只在该目录里按该引擎的 `bin` 名找（`findBin(bin, [dir])`，不回落 PATH，否则「测试通过」可能测的是别人）→ 跑 `--version` 探针（ADR-0028 的 `installed ≠ usable` 规则原样复用：能找到但无输出仍是不可用）→ 返回 `{ok, code, path?, version?}`。**不写任何文件**；落库只走配置页的统一保存。
6. **目录输入的失败原因必须分类返回**（`code`：`not-absolute` / `not-found` / `no-output` / `unknown-cli` / `probe-failed`），前端映射成 i18n 文案。返回内部措辞（`spawn ENOENT` 之类）等于把实现细节交给用户，而用户能做的动作只有「改目录」或「去登录」——文案必须落到这两个动作上（`http-error.mjs` 同一纪律）。
7. **测试与保存分离。** 「指定目录」落在引擎区——那是**统一保存**区（●），草稿进 `pending` 计数、点底部「保存设置」才落库；测试按钮只验证当前草稿并按结论给回执。不把「测试通过即自动保存」写进去：一次输入框回车就永久改掉派发路径，比多按一次保存危险。
8. **接口边界只放开「该引擎的 bin 名」，不放开任意可执行文件。** `/api/clis/verify` 的入参只给 `cliId`（必须是 `KNOWN` 的 id）和目录；二进制名由服务端的 `CliSpec.bin` 决定，用户无法借这个接口跑任意程序。目录必须是绝对路径（`~` 前缀按 home 展开），相对路径一律拒绝——服务端 cwd 对被派发的子进程没有意义。
9. **目录可以点选，而且只能由本机进程弹框。** 页面能拿到的目录都不带盘符（`showDirectoryPicker()` 只给 `FileSystemDirectoryHandle`，`<input webkitdirectory>` 只给 `webkitRelativePath`），而 `cliDirs` 要存的是能交给 `spawn` 的绝对路径。所以新增 `POST /api/clis/pick-dir`：服务端用 PowerShell 弹 `FolderBrowserDialog`，回 `{status: "picked", dir}` / `cancelled` / `unsupported` / `busy` / `failed`。
   - **对话框必须挂 owner 窗口**：实测 `ShowDialog()` 不带 owner 时不弹框、直接返回 `Cancel`——用户看到的就是「点了没反应」。owner 是一个 1×1、`Opacity = 0`、不进任务栏的隐藏 Form，只负责让对话框成为它的模态子窗口并置前。
   - **路径回执走 base64**（UTF-8 字节）：PowerShell 5.1 往管道写非 ASCII 时编码随控制台代码页走，中文/日文目录名会被嚼碎。起始目录用环境变量传入，避开命令行引号与转义（`Program Files`）。
   - 边界：不读配置、不写配置；选中的目录只是草稿，能否用仍由 `/api/clis/verify` 回答，落库仍走统一保存（决议 7）。选完立刻自动验一次（那一刻 state 还是旧值，所以 `testCliDir` 接受覆盖目录）。
   - `busy`：同一时刻只开一个对话框——连点两下会得到两个模态框，第二个无处可关。
   - **只做 Windows**：其余平台回 `unsupported`，界面让用户继续粘贴路径。没有验证过的平台分支是负债。

## Alternatives considered

- **让用户直接填二进制完整路径，而不是目录。** 少一次拼接，但对「我装在这个文件夹」这个真实心智不匹配，而且会绕过 `findBin` 的 npm `node_modules` 深挖与可执行性判定（Windows 上 `.cmd`/扩展名 shim 的坑，ADR-0053）。目录 + 引擎自己的 `bin` 名是唯一能保持「可解析 = 可 spawn」的做法。否决。
- **把目录写进 `localStorage`，与 `cliId`/`model` 同路。** 派发端读不到（headless 子进程），会出现「配置页显示已指定、实际派发用不上」——正是 ADR-0028 决议 3 要消灭的那种静默丢写。否决。
- **保存后由前端再调一次 `/api/clis?refresh=1` 就算完。** 只覆盖配置页这一个消费者；托盘壳、扩展、直连 `/api/config` 的路径都看不到新目录。改成签名失效后，正确性不再依赖谁来调。前端仍会在保存后主动 recheck（体验更好），但那不再是正确性的前提。
- **指定目录找不到时直接判该引擎「不可用」（不回落自动链路）。** 语义更严格，但一个被删掉的目录会让本来能用 PATH 找到的引擎突然不可用，且与「检测不到才需要指定」的初始动机自相矛盾。否决，改为「前插 + 找不到继续原有链路」，由 `pathSource` 如实说明这次用的到底是不是你指定的那个。
- **在页面里自己画一个目录浏览弹层。** 跨平台、不依赖 GUI 权限，但要自己实现盘符枚举、父目录、权限错误、长目录、UNC 与软链，还要再开一条「列目录」的 API 面；而用户要的是「像资源管理器那样选一个文件夹」，系统对话框已经解决这些，且与既有心智一致。否决（将来要支持非 Windows 平台时，这是首选替代）。
- **让页面用 `showDirectoryPicker()` / `<input webkitdirectory>` 选。** 两者都拿不到盘符：`FileSystemDirectoryHandle` 与 `webkitRelativePath` 都不是能交给 `spawn` 的绝对路径。否决。
- **把「选中的目录」当成已保存。** 与决议 7 冲突：选目录只是把格子填好，落库仍然是统一保存那一下。否决。
- **给已安装引擎也开一个「覆盖目录」入口。** 同一个解析逻辑天然支持，但界面上会多出一排没人要求的输入框，且用户没有「已经能用」的动机。本 ADR 只在未安装分组里给出入口；已装引擎写进 `cliDirs` 依然生效，只是暂不在界面暴露。

## Consequences

- 装了但不在 PATH/常见目录的 CLI，从「重装或自己改 PATH」变成「填目录 → 测试 → 保存」三步，且保存前就知道这个目录到底对不对（路径 + 版本号回执）。
- 一个填错的目录不会再静默进入派发：测试会回 `not-found`；即使绕过测试保存，检测仍报未安装（`installed: false`），不会被 `pickDefaultInstalled` 选中。
- `pathSource: "custom"` 让「同一个引擎的二进制可能来自不止一处」（ADR-0053 决议 10）多了一格可回答的信息：这次是你指定的那一份。
- 装了但不在 PATH 的引擎，从「打开资源管理器 → 复制路径 → 粘回来 → 点测试」缩成「点文件夹图标 → 选 → 自动测」。
- 对话框由服务进程弹：若服务被以无桌面的系统服务方式运行，`spawn` 或 `ShowDialog()` 失败会以 `failed` 回执落到界面（「打不开目录选择窗口 —— 请手动粘贴路径」），不会静默；手动输入始终可用，功能不依赖它。
- 新增一个长挂请求（最长 180s，即用户开着对话框的时间），同一时刻只允许一个（`busy`）。它不持锁、不写文件；标签页被关掉时只会等到超时。
- 新增一个跨 `/api/config` 与 `/api/clis` 的读路径：每次检测/派发会多读一次 `~/.career-ops-web/config.json`（小文件、同步读，与 `readAppConfig` 现有开销同级）；派发本来就不是热循环。
- 未覆盖：目录的「有效性」不做持续监控——目录在保存后被删除时，检测退回自动链路（`installed` 可能仍为 true），界面不报错；用户下次打开配置页会看到该引擎已不在「未安装」分组，需要手动重新指定。这是刻意选择：把「指定目录失效」做成常驻告警需要一套与本次无关的目录健康检查。
- `cliDirs` 是纯用户数据，进 `~/.career-ops-web/config.json`，不进仓库、不进 `data/`，与 Data Contract 无冲突。

## References

- ADR-0004 D3（服务端配置持真值：headless 子进程读不到 localStorage）
- ADR-0015（检测结果进程内缓存 + 手动重检为唯一失效途径，本 ADR 决议 4 把「目录变了」也算作失效）
- ADR-0028（`installed ≠ usable`：`--version` 探针）
- ADR-0052 / 0053（`binDirs`/`fallbackDirs` 与「可解析 = 可 spawn」）
- ADR-0073 决议 2（页面打开不落盘：指定目录同样只进草稿）
- `web/src/lib/clis.ts`、`web/src/lib/cli-bin-dirs.mjs`、`web/src/lib/app-config.ts`、`web/src/lib/http-error.mjs`、`web/src/lib/pick-dir.mjs`
- 测试：`web/tests/lib/cli-custom-dirs.test.mjs`、`web/tests/lib/cli-bin-dirs.test.mjs`（既有接线守卫）、`web/tests/lib/pick-dir.test.mjs`（选择器与回执解码）
