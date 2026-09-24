# ADR-0058: 「打开定制简历所在位置」窗口前置（后台服务器绕过 Windows 前台锁定）

## 状态

Accepted (2026-09-24)

## 背景

报告页的「打开定制简历所在位置」按钮（`open-cv-folder-button.tsx` → `POST /api/cv-pdf/open`）由服务器 spawn `explorer /select,<path>` 来定位定制简历 PDF。用户日常运行方式是**双击 exe 启动器**——Next.js standalone 服务器由启动器以后台进程身份拉起。Windows 的前台锁定（foreground lock）规定只有持有前台激活权限的进程才能把窗口摆到 Z 序最前，后台服务器 spawn 的 explorer 窗口因此**每次开到浏览器背后**：文件确实被选中了，但用户看不到，以为没反应。

约束：

1. 点击发生在浏览器里，但真正 spawn 窗口的是服务器进程——浏览器无法代为前置（`file://` 导航被现代浏览器封死）。
2. 启动器与 web 服务器之间没有现成的 IPC 通道，前置不能依赖启动器配合。
3. explorer 多窗口共享同一个 `explorer.exe` 进程，进程级 `MainWindowHandle` 无法定位到具体窗口。
4. 接口的即发即忘语义是原路由注释里立过的（explorer 成功也常返回非零退出码，退出码无意义），不应为前置结果改约。

## 决策

1. **修在服务端，前端零改动**：`/api/cv-pdf/open` 的 win32 分支改调 `web/src/lib/win-reveal.mjs`；按钮组件、toast 文案、i18n 全部不动。
2. **实现载体 = 内联 PowerShell helper**：spawn `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command <脚本>`，脚本由 `buildForegroundScript()` 在 `win-reveal.mjs` 里拼装。不新增仓库 `.ps1` 文件（免得跟着 standalone 打包/exe 解压链路多一份分发一致性风险），不加编译产物。接受的代价：点击后窗口"过一小会儿才飞过来"（PowerShell 冷启动 + Add-Type 首次编译约 1–2s，之后有 OS 级程序集缓存）。
3. **前置机制 = `SwitchToThisWindow`**（user32，Alt+Tab 专用入口，不受前台锁定约束）；窗口枚举走 `Shell.Application` COM 的 `Windows()` 集合，用每个窗口的 `Document.Folder.Self.Path` 与 PDF 父目录比对（去尾分隔符、`-ieq` 忽略大小写）。命中即前置。
4. **接口语义保持 fire-and-forget**：接口仍然立即返回 `ok:true`（陈述"spawn 发生了"，不陈述"窗口在前台"）；explorer 是 GUI 进程走 `detached + unref`，helper 则是 **非 detached 的 `{stdio:"ignore", windowsHide:true} + unref`**——实施后实测发现 detached 的 powershell.exe（控制台应用）拿不到控制台会**启动即静默死亡**（marker 实验：detached 子进程连第一行日志都写不出），初版实现因此完全不生效；unref 足以维持即发即忘，父进程退出也不会带走子进程。失败静默。
5. **竞态礼仪 = 短窗口内必抢**：helper 在 ≤3 秒内以 150ms 间隔轮询目标窗口，窗口一出现就前置——即使此刻用户切去了别的窗口也照抢（点击即意图）；超时窗口没出现则静默退出，不检测用户输入、不重试。
6. **平台范围 = 仅 Windows**：darwin 的 `open -R` 与 linux 的 `xdg-open` 本来就能到前台，分支原样保留（单测里有源码锁防止误改）。
7. **验证分层**：单测（`web/tests/lib/win-reveal.test.mjs`）锁脚本拼装（P/Invoke/COM/超时要素齐全、单引号加倍转义撕不开字面量）、spawn 编排（先 explorer 后 helper、**helper 禁 detached 回归锁**、error 静默）、路由接线（win32 分支不许再有裸 `spawn("explorer")`）；前置效果本身需要真实桌面会话，无法 CI 断言，由本机手动清单验证。
8. **交付落点**：源码改动在终端 dev 服务器上验证；用户日常双击的 exe 用 `node local/pack-launcher.mjs` 当场本地重打包，按项目四判据验收（exe 大小/时间戳、`/api/version` 字段对齐、HEAD SHA 一致、runtime 目录清理）。本地重打包属本地构建，不触发 L3 安全扫描。

## 被否的方案

- **改交互：直接打开 PDF 本身**——阅读器窗口同样受前台锁定管辖，问题没消失只换了宿主；且按钮语义是"定位文件"不是"打开阅读"。
- **降级体验：不抢前台，toast 给路径 + 任务栏闪烁**——治标，用户明确要求真前置。
- **预编译 `reveal.exe` 小工具随启动器分发**——零冷启动延迟，但为单个按钮新增构建产物和打包链路，成本不成比例。
- **独立 `.ps1` 脚本文件**——可读性好一点，但要在 Next standalone 打包与 exe 解压链路里多保一个新文件的分发一致性。
- **启动器（Go）持有前台权限代抢 / `AllowSetForegroundWindow`**——需要启动器与服务器之间新辟 IPC，架构变更远超按钮修复的范围。

## 后果

- 正面：按钮所见即所得；前台效果达成时非 Windows 平台与接口契约零影响；helper 挂掉（COM 不可用、超时无窗口）退化的就是修复前的旧行为——窗口开到背后——不会更糟。
- 行为口径：若目标目录已有开着的资源管理器窗口，`explorer /select` 会在既有窗口里切换，helper 同样按目录匹配把它前置——新窗口/复用窗口两种情形行为一致。
- 每次点击多活一个隐藏 powershell 子进程，≤3s 内自行退出。
- 陷阱记录（首轮验证失败的直接原因）：Windows 下 `detached:true` 对控制台应用等于判死刑——powershell 静默不执行且无任何报错，exit 事件对 detached 子进程还可能不触发；唯一的决定性证据是子进程自己往文件写 marker 再回读。已由单测断言锁死（helper 禁 detached）。
- 维护点：`SwitchToThisWindow` 是 undocumented 但二十年稳定的 user32 入口；`Shell.Application` COM 依赖桌面会话存在——在无桌面的服务化部署里 helper 静默失败，行为回退到修复前。

## References

- `web/src/lib/win-reveal.mjs`（`buildForegroundScript` + `revealCvPdfInExplorer`）、`web/src/app/api/cv-pdf/open/route.ts`（唯一调用方）、`web/tests/lib/win-reveal.test.mjs`（脚本拼装/编排/接线锁）。
- `web/src/lib/cv-pdf-resolve.mjs`（路径解析共用，本 ADR 不触碰——路径来自服务端索引，helper 无外部注入面，仅字面量转义做防线）。
- 术语表：`docs/glossary-desktop-reveal.md`（本次新增「前台锁定」「窗口前置」「定位揭示」「短窗口内必抢」「前置 helper」）。
- ADR-0055（同为"扩展/服务器请 OS 打开东西"的行为收口先例）、ADR-0013（PDF 生成提速——`/api/cv-pdf/*` 一族路由的由来）。
