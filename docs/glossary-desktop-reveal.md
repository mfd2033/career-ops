# Glossary — 桌面文件定位与窗口前置

协同阅读：`docs/adr/0058-cv-reveal-foreground-helper.md`

## 语义分层

- **定位揭示（reveal）**：在文件管理器中打开目标文件所在文件夹并选中该文件（Windows `explorer /select,`、macOS `open -R`）。只承诺"文件被选中"，不承诺"窗口被你看见"——后者是「窗口前置」，两回事。
- **窗口前置（foregrounding）**：把一个已存在或刚出现的窗口摆到 Z 序最前并给它焦点。OS 层面的独立能力，不随 reveal 自动获得。
  _Avoid_: 置顶（always-on-top 是另一回事，本功能不做持续置顶）
- **前置 helper（foreground helper）**：`win-reveal.mjs` 在 reveal 之后追加 spawn 的隐藏 powershell 子进程，专职在轮询窗口内找到目标资源管理器窗口并用 `SwitchToThisWindow` 前置。尽力而为、即发即忘、≤3s 自行退出。

## OS 机制

- **前台锁定（foreground lock）**：Windows 规则——只有当前持有前台激活权的进程（及其子进程链）才允许把窗口带到前台。后台服务/启动器拉起的服务器 spawn 的窗口因此开到背后。是本 bug 的根因名词，修复不"解除"锁定，只是走锁定上预留的旁门（`SwitchToThisWindow`）。
- **短窗口内必抢（bounded grab window）**：本功能的竞态礼仪——helper 在有限轮询窗口（默认 3s/150ms）内见到目标窗口就前置，不因为用户此刻在操作别的窗口而让步、不重试、不检测输入。窗口没出现则静默放弃。与"单次尝试不重试""检测用户操作则让步"两个被否口径相对。
- **既有窗口切换（window reuse）**：目标文件夹已有开着的资源管理器窗口时，`explorer /select` 不新建窗口而是在既有窗口内切换选中；helper 按目录路径匹配窗口，两种情形（新窗口/复用窗口）前置行为一致。
