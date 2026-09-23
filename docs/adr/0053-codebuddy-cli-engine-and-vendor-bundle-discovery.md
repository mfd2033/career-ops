# ADR-0053: 接入 CodeBuddy（codebuddy/cbc）为可派发运行时（惰性厂商目录兜底 + 复用 Claude 事件解析）

## 状态

Accepted (2026-09-23)

## 背景

#16 原本要求一条 PR 同时接 Qoder 与 CodeBuddy 的 stream-json。Qoder 已由 ADR-0052 落地（工单 #6–#10 全绿）；CodeBuddy 当时因「本机找不到 agent CLI」被拆成阻塞式待办 #18。2026-09-23 的四轮排查推翻了那个前提：**本机确实有 CodeBuddy 的 agent CLI，只是它既不在 PATH、也不是 npm 全局包**。

**实测事实**（本机 WorkBuddy 桌面端 5.5.6 自带的 CodeBuddy CLI v2.137.1；系统 node v22.23.2；模型 `hy3`；4 份真实样本共 167 行）：

- **位置与形态**：`<WorkBuddy 安装目录>\resources\app.asar.unpacked\cli\`，`package.json` 是 `@genie/agent-cli`，`bin` 声明 `codebuddy` / `cbc` / `codebuddy-code` → `./bin/codebuddy`（node 脚本，自带 minNode 检查 18.20.8），另有 `dist/codebuddy.js`（22.7 MB）与 `dist/codebuddy-headless.js`，自带 `node_modules` 与 `vendor`。本机安装目录是 `D:\workbuddy`（注册表回显小写，Windows 不区分大小写）。
- **认证**：不需要单独登录——`system/init` 的 `apiKeySource` 实测为 `copilot.tencent.com`，复用腾讯 Copilot 登录态。
- **参数面**：`-p/--print`、`--output-format text|json|stream-json`、`--include-partial-messages`、`--model`、`--allowedTools`/`--disallowedTools`、`--permission-mode acceptEdits|default|plan|dontAsk|auto|bypassPermissions`、`--tools`、`--settings`、`-y/--dangerously-skip-permissions`。参数名是**驼峰**（`acceptEdits` / `--allowedTools`），与 Claude 一致、与 Qoder 的 `accept_edits` / `--allowed-tools` 相反。
- **事件形状**（逐行 JSONL）：`system/init`（含 `model`、`cwd`、`permissionMode`、**34 个内置工具**、74 条 slash_commands）、`system/status`、`file-history-snapshot`、`stream_event`（`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`）、`assistant`（`thinking` / `tool_use` / `text` 块）、`user`（`tool_result`）、`result`（`subtype:"success"`、`is_error`、`result` 文本、`usage`、`total_cost_usd`、`modelUsage`）。除 `system/status` 与 `file-history-snapshot` 外**逐行与 Claude 同形**。
- **解析复用已实测**：把 4 份样本（22/129/8/8 行）喂给现有 `parseClaudeEvent`——**0 异常**，按 `ParsedEvent` 契约产出 `{status}` / `{text}` / `{tool, detail}` / `{tokens, costUsd}`，tool 事件带参数摘要（`detail:"echo hi"`）；`system/status` 与 `file-history-snapshot` 静默返回 `null`。**解析层零改动即可复用。**
- **用量**：`result.usage` 与 `modelUsage` 是**真实 token**（实测 49611 / 76732 / 76229 / 76603），但 `total_cost_usd` 恒为 `0`。与 Qoder（全 0，只报 credits）**相反**。
- **权限**：`-y` **不是**必需。实测三条路径：`--settings '{"permissions":{"allow":["Bash"]}}'` → Bash 真执行（回显 `Stdout: hi` / `Exit Code 0`）；`--allowedTools 'Bash(echo:*)'` → 同样执行；**裸名** `--allowedTools=Bash,Read` → 被拒（`Permission to use Bash has been denied because this tool requires approval but permission prompts are not available in non-interactive session`）。即：授权必须写成 `Tool(pattern)` 或 settings 的 allow 列表形式，裸工具名不足以授权。
- **argv 顺序坑**：`--allowedTools` 是变参（`<tools...>`），会把写在它**后面**的位置参数 prompt 一起吞掉——实测「prompt 放最后 + `--allowedTools Bash,Read`」退化成 2 行、`model=unknown`、`result:""`。prompt 紧随 `-p` 可用；`--model` 追加在 prompt 之后也可用（与 Qoder 同结论）。
- **官方 npm 通道**：`@tencent-ai/codebuddy-code` 存在，latest `2.156.0`（比捆绑的 2.137.1 新）。本机 npm 全局前缀是 `D:\root\.npm-global`（由 `npm config prefix` 改动而来），**不在 PATH**，且 Windows 上 shim 落在前缀根目录而非 `bin/`，所以现有 `searchDirs()` 的 `~/.npm-global/bin` 与 `%APPDATA%\npm` 两条都命中不了。
- **安装目录可通用定位**：`InstallLocation` 是空的，但卸载键（`HKCU\...\Uninstall\BFD312E9-…`）的 `DisplayIcon` / `UninstallString` 都带真实安装目录（实测 `D:\workbuddy\WorkBuddy.exe`）。

## 决策

1. **范围**：接入官方 agent CLI，`id: "codebuddy"`、label `"CodeBuddy"`、`bin: "codebuddy"`、`url: "https://www.codebuddy.cn/"`。**不接** IDE 的 `buddycn`（实测那是 VS Code 式启动器：`--version` 回 VS Code 版本串、`--help` 回 `--diff`/`--merge`/`--goto`，无 `-p`、无 `--output-format`）。
2. **探测分两级，两条通道都要真能用**：
   - 主路径（`binDirs`，复用 ADR-0052 的声明式厂商目录）：官方原生安装在 Windows 上的落点 `~/AppData/Local/codebuddy/bin`。官方安装产出的才是**真正的 `codebuddy.exe`**（安装脚本下载 `codebuddy-code_Windows_x86_64.zip`，脚本自身就假定包内有 `codebuddy.exe`）。
   - 兜底路径（`fallbackDirs`，新字段）：WorkBuddy 桌面端捆绑在自己安装树里的副本（`<安装目录>\resources\app.asar.unpacked\cli\`）。**本机只装了这一个通道**，用户明确要求它可用，所以它必须是真通道而不是「仅留痕」。
3. **解释器前缀放在拥有 spawn 职责的那一层**：两条通道交付的都是**无扩展名的 `#!/usr/bin/env node` 脚本**（npm 包的 `bin` 同样如此，整包内没有 `codebuddy.exe`），而 Windows 的 `CreateProcess` 需要可执行扩展名——实测直接 spawn `…\cli\bin\codebuddy --version` → `ENOENT`，`node <该脚本> --version` → `2.137.1`。修法不是给 9 个 spawn 点各加一次前缀，而是 `spawn-cli.mjs` 新增 `spawnTargetFor(binPath)`：按**文件内容**识别 node 脚本并前置解释器（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`，后者对真 node 无害、对 Electron 宿主必需），非 node 脚本（`.cmd`/`.bat`/sh shim）原样返回。`probeHeadlessUsable` 也走同一目标，否则会报「已安装但不可用」。
4. **不写死机器路径**：`binDirs` 一律 home 相对（同 Qoder 的 `~/.qodersec/bin`）；捆绑副本的目录取决于用户把 WorkBuddy 装在哪儿，因此由 `fallbackDirs` 在**运行时**从 Windows 卸载注册表取安装目录（实测 `InstallLocation` 为空，`DisplayIcon`/`UninstallString` 才带真实路径），**不把 `D:\workbuddy`、`D:\root\.npm-global` 这类机器特定路径写进代码**。`fallbackDirs` **只在主查找失败后调用一次**（定位要 spawn `reg query`，检测扫描不该为此付代价），且失败即返回空、引擎回落为「未安装」。
5. **argv 归属与形状**：新建 `web/src/lib/codebuddy-invocation.mjs`，导出 `codebuddyCliArgs({kind, prompt})`。形状：`-p <prompt> --output-format stream-json --include-partial-messages <权限 flags>`，**prompt 紧随 `-p`**（变参吞参数那个坑），**不带 `-y`**。
6. **权限域单一来源，但传输不用 Claude 的 flag 形状**（实现期实测修正）：allow/deny 的**集合**仍复用 `claude-invocation.mjs` 的 `toolScopeFor(kind)`，**传输改用 `--settings '{"permissions":{"allow":[…],"deny":[…]}}'`**。理由是实测出来的，不是偏好：

   | 传输方式 | 实测结果（v2.137.1） |
   |---|---|
   | `--allowedTools "Read,Bash"` | Bash **被拒** —— allow 未生效 |
   | `--allowedTools "Bash(echo:*)"` | 生效（单一 spec 可用） |
   | `--disallowedTools "Bash,PowerShell,…"` | Bash 被拒 ✓，但 **`PowerShell` 照样执行成功** ✗（静默的权限漏洞） |
   | `--settings` 的 `allow:["Bash"]` | Bash 执行成功 |
   | `--settings` 的 `deny:["Bash","PowerShell",…]` | 模型**零工具调用**，回答「没有 shell 工具」 |

   即逗号拼接的 flag 形式在 CodeBuddy 上双向不可靠，其中一个是安全漏洞；`--settings` 两个方向都有效（deny 是真的把工具从工具集里移除，不是调用时拒绝）。另外实测确认 **allow 不是白名单**：`allow:["Read"]` 且 deny 未提 `PowerShell` 时，`PowerShell` 会被调用并执行——所以**安全完全依赖 deny 的完备性**，`CODEBUDDY_EXTRA_DENIED` 必须覆盖 CodeBuddy 工具集里每一个执行/写入工具，`PowerShell` 是其中最要命的一个（Qoder 的 `Monitor` 同类，ADR-0052 决议 4）。
7. **超集拒绝名单**：`system/init` 列出的 34 个内置工具是 Claude 工具集的超集，含 `PowerShell`、`Write`、`Edit`、`Bash`、`Agent`、`Task*`、`TeamCreate/Delete`、`SendMessage`、`WeChatReply`、`WeComReply`、`MessageColleague`、`SpeakInChannel`、`ImageGen`、`VideoGen` 等有执行/写入/外部副作用的工具。照 ADR-0052 决议 4 的做法，叠加一层 CodeBuddy 专属拒绝名单，并由测试逐字锁定。**维护点同 ADR-0052**：名单是对着 v2.137.1 的 34 个名字核出来的，CLI 升级后需重新核对。
8. **事件解析**：直接复用 `parseClaudeEvent`（已实测，解析层零改动）。`system/status` 与 `file-history-snapshot` 靠它的默认 `null` 静默丢弃；`thinking`、`tool_result` 行的处理与 Claude 一致。
9. **用量显示**：**保留 tokens**（`result.usage` 是真实值），**只屏蔽 `costUsd`**（`total_cost_usd` 恒为 0，显示 `$0.00` 等于宣称免费）。与 Qoder 决议 6 的屏蔽对象**相反**——Qoder 两个都假，CodeBuddy 只有费用假。
10. **版本护栏**：引擎卡显示探测到的**完整路径 + `--version` 输出**，让「这次用的是哪个二进制、哪个版本」永远可见。本 ADR 的形状验证绑定 **2.137.1（WorkBuddy 捆绑版）**；官方 npm latest 是 2.156.0，两版形状**未逐一比对**——探测到不同版本时，形状差异属于已明示的未知。
11. **只读捆绑副本**：绝不对 WorkBuddy 目录里的副本执行 `codebuddy update` / `codebuddy install`（会写进另一个产品的安装目录）。dashboard 只调用、不维护它。
12. **批量不动**：`batch-evaluate` 继续 `isClaude` 分支，CodeBuddy 在批量里走纯文本（同 ADR-0049 决议 5、ADR-0052 决议 14）；batch 泛化仍是独立待办。
13. **测试样本不入库**：4 份原始样本含本机绝对路径、`slash_commands`（技能清单）与会话 id，只按 `run-cli-support.test.mjs` 的既有风格提炼手写最小行（补 `file-history-snapshot`、`system/status`、`thinking`、`tool_result` 这些现有测试未覆盖的形状）。
14. **文档**：`docs/SUPPORTED_CLIS.md` 增一行（Headless 列写实测过的调用方式；未实测的列留 `—`）+ `cli-labels.mjs` 增标签 + 一条变更记录。
15. **验证口径**：单测 + typecheck + dev 真跑一次 + **重新打包后再真跑一次**（对齐 ADR-0047 / 0049 / 0052）。

## 实现期发现（已解决：捆绑副本经解释器前缀成为真通道）

**CodeBuddy CLI 在任何通道里都不是可直接 spawn 的可执行体** —— 它是一个 `#!/usr/bin/env node` 脚本，必须先有一个解释器前缀：

- WorkBuddy 捆绑副本：`cli/bin/` 下只有无扩展名的 `codebuddy`（8 KB node 脚本）。实测**直接 spawn `…\cli\bin\codebuddy --version` → `ENOENT`**；`spawn(process.execPath, [脚本, "--version"])` → `2.137.1`。整个 bundle 里 `*.exe` 只有 vendor 工具（rg、sandbox-cli、genie-trash…），**没有 `codebuddy.exe`**。
- 官方 npm 包：`bin` 映射 `codebuddy`/`cbc`/`codebuddy-code` → `bin/codebuddy`（同一个无扩展名脚本），`optionalDependencies` 只是原生 addon（`@lydell/node-pty-*`、`@tencent-ai/sandbox-cli-*`），**同样没有 `.exe`**。

而仓库的 spawn 契约（`spawn-cli.mjs` 顶部注释）明确要求：`binPath` 必须是**可直接 spawn 的可执行体**，在 Windows 上**绝不**是 `.cmd`/`.bat` shim 或无扩展名 POSIX 脚本 —— 因为走 `cmd.exe` 会把多行 prompt 截断在第一行（而评估类 prompt 是多行的）。所以：

- 现在把 CodeBuddy 加进 `KNOWN`，`findBin` 的最末兜底会返回那个无扩展名脚本 → 引擎被报成「已安装」，派发时 `ENOENT`。这正是 ADR-0052 那条不变式（配置页报已安装的引擎必须可 spawn）要禁止的形态。
- 「让它可以工作」的修法有两种：给 **9 个 spawn 点**（`/api/run`、`batch-evaluate`、`batch-checkup`、`assistant`、`cv/ingest`、`explore/ai`、`apply/prefill`、`apply/drive`、`apply/agent-interpret`）与 `probeHeadlessUsable` 各加一次解释器前缀（宽改动），或把前缀收进**拥有 spawn 职责的那一层**。选了后者：`spawn-cli.mjs` 的 `spawnTargetFor(binPath)` 按内容识别 node 脚本，于是「可解析」与「可 spawn」在新引擎上重新一致，而调用点一行未改。
- 官方原生安装（Beta）产出的确实是**真正的 `codebuddy.exe`**（安装脚本下载 `codebuddy-code_Windows_x86_64.zip`），落点 `%USERPROFILE%\AppData\Local\codebuddy\bin` —— 保留为 `binDirs` 主通道；但本机只有捆绑副本，所以它不能是唯一通道。
- 用户决定：**以捆绑副本为准做「能用」**，官方 CLI 只当「可以装」、不再实测验证。

**结论**：两条通道都接（`binDirs` 主 + `fallbackDirs` 兜底），都经 `spawnTargetFor` 以解释器启动。dev 模式实测 `/api/clis` → `codebuddy: installed=true usable=true version=2.137.1`，path 指向捆绑副本。决议 2/3/4 已按此改写。

- **只探官方 npm 安装，不接捆绑副本**：环境更干净，但要求用户先装一次、且本机 npm 前缀不在搜索面，等于把「今天就能用」推迟到用户改完环境之后。作为第二级保留而不是唯一级。
- **把 `D:\workbuddy\...` 写进 `binDirs`**：把一台机器的盘符与安装选择固化进代码，换机即错。被否（这正是决议 4 要防的形态）。
- **每次探测都读注册表**：`/api/clis` 每次多一个子进程，只为一条极少命中的兜底路径。被否，改惰性（决议 3）。
- **照 Qoder 的做法屏蔽 tokens**：CodeBuddy 的 token 是真实的，屏蔽等于丢真数据。被否（决议 9 只屏蔽费用）。
- **在 `/api/run` 路由里按引擎分支拼 argv**：权限策略被埋进路由，工具域出现第二份副本（#10 要防的漂移形态）。被否，与 ADR-0052 决议 2 同因。
- **用 `-y` 让工具跑通**：`clis.ts` 顶部明令禁止任何 runtime 给自己超出被审计者的权限；且实测证明**不需要**它（allow 列表形式即可）。被否。
- **把 CodeBuddy 的决策并进 ADR-0052**：0052 的主题是 Qoder CN，混入第二个引擎会让它的范围失真。改为独立编号。

## 后果

- 正面：dashboard 第 4 个有逐工具步骤的运行时；解析层零改动（复用已验证）；权限域仍单一来源并被测试锁住；用量比 Qoder 更诚实（token 真实）。
- 已知缺口（明示，非缺陷）：捆绑副本的**版本随 WorkBuddy 升级而变**，形状验证只覆盖 2.137.1；卸载 WorkBuddy 后该引擎即消失（回落为「未安装」）；费用显示为「无申报」而非真实金额；批量评估里仍无步骤。
- **依赖跨界**：引擎的二进制可能来自**另一个产品的安装目录**。这是本 ADR 唯一真正新鲜的东西——代价是「CodeBuddy 引擎可用性」耦合到 WorkBuddy 的存在，收益是零安装即可用，且失败时静默回落、不产生假阳性。
- 相关未清事项：`/api/run` 之外仍有 5 个路由各自手写 `isClaude ? [...] : spec.args(prompt)`（cv-ingest、batch-evaluate、assistant、apply-prefill、explore-ai），仍属 #2507 那条线。
