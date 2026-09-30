// win-reveal.mjs —— Windows 桌面专用：在资源管理器中定位文件，并把窗口抢到前台。
//
// 背景（ADR-0058 及其修订 2026-09-30）：/api/cv-pdf/open 由 career-ops web 服务器
// spawn `explorer /select,<path>`。服务器是 exe 启动器拉起的后台进程，Windows 的
// 前台锁定（foreground lock）禁止后台进程把窗口摆到 Z 序最前 —— 资源管理器窗口
// 每次都开到浏览器背后。修复：再 spawn 一个隐藏窗口的 powershell helper，
// 轮询找到路径匹配目标目录的 Explorer 窗口并前置。
//
// 前置机制的关键教训：单调 SwitchToThisWindow 不够 —— 实测（启动器→node→helper
// 整链 marker 日志）它在不持前台权限的后台进程里调用成功但窗口纹丝不动；
// 真生效靠经典前台窃取组合拳：ShowWindow(SW_RESTORE) 还原最小化窗 →
// AttachThreadInput 挂接前台线程 → keybd_event 模拟 ALT 按下（重置前台锁定标志）
// → SetForegroundWindow + BringWindowToTop → SwitchToThisWindow 叠加兜底 → ALT 抬起
// → 解除挂接。Windows 把“刚按过 Alt 的进程”视为持有前台权限，组合拳是公开
// 文档认可的合法绕法（SetForegroundWindow 官方文档列出的豁免条件之一）。
//
// 决议口径（见 ADR-0058）：
//   - 接口语义保持即发即忘：explorer 走 detached+unref，helper 走
//     非 detached 的 windowsHide+unref（控制台应用 detached 会启动即死），
//     调用方都不等待；
//   - 短窗口内必抢：默认 ≤3s 轮询，目标窗口一出现就前置；超时未出现则静默放弃，
//     不检测用户输入、不无限重试；
//   - 仅 Windows。darwin/linux 的 open -R / xdg-open 本来就能到前台，不经过这里。
//
// 前置效果无法在 CI 断言（需要真实桌面会话）；单测锁脚本拼装与 spawn 编排
// （web/tests/lib/win-reveal.test.mjs），效果验证走本机手动清单。

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

// PowerShell 单引号字面量：内部单引号加倍，路径逐字保留（反斜杠不转义）。
// 路径来自服务端 resolveCvPdf（output/ 下的真实文件），这里仍是防线：
// 绝不让目录名撕开字符串字面量。
function psSingleQuoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// 拼出传给 powershell -Command 的前置脚本：轮询 Shell.Application 的打开窗口，
// 逐个比对 Document.Folder.Self.Path 与目标目录（去尾分隔符、忽略大小写），
// 命中即组合拳前置并 exit 0；超时 exit 1（调用方不读退出码）。
export function buildForegroundScript(dirPath, { timeoutMs = 3000, pollMs = 150 } = {}) {
  const timeout = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000;
  const poll = Number.isInteger(pollMs) && pollMs > 0 ? pollMs : 150;
  const target = psSingleQuoteLiteral(dirPath);
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$target=${target}`,
    // HWND 级前置入口集合；explorer 多窗口共享进程，进程 MainWindowHandle 不可靠，
    // 所以窗口枚举走 Shell.Application 而不是 Get-Process。
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class CareerOpsForeground{[DllImport(\"user32.dll\")]public static extern void SwitchToThisWindow(IntPtr hWnd,bool fAltTab);[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr hWnd);[DllImport(\"user32.dll\")]public static extern bool BringWindowToTop(IntPtr hWnd);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);[DllImport(\"user32.dll\")]public static extern void keybd_event(byte bVk,byte bScan,uint dwFlags,UIntPtr dwExtraInfo);[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd,IntPtr lpdwProcessId);[DllImport(\"kernel32.dll\")]public static extern uint GetCurrentThreadId();[DllImport(\"user32.dll\")]public static extern bool AttachThreadInput(uint idAttach,uint idAttachTo,bool fAttach);}'",
    "$shell=New-Object -ComObject Shell.Application",
    // 窗口集合是 Windows() 方法返回值，不是 $shell 自身 —— Shell.Application 没有
    // Count/Item 直接属性，写错会让轮询永远空转（首轮冒烟实测的 bug）。
    "$wins=$shell.Windows()",
    `$deadline=(Get-Date).AddMilliseconds(${timeout})`,
    "while((Get-Date) -lt $deadline){",
    "  for($i=0;$i -lt $wins.Count;$i++){",
    "    $w=$wins.Item($i)",
    "    $p=$null",
    "    try{$p=[string]$w.Document.Folder.Self.Path}catch{}",
    "    if($p){",
    "      if($p.TrimEnd('\\') -ieq $target.TrimEnd('\\')){",
    // 前台窃取组合拳（顺序敏感）：还原→挂接→按 ALT→置前台→置顶→兜底→抬 ALT→解挂。
    "        try{$h=[IntPtr]$w.HWND;[CareerOpsForeground]::ShowWindow($h,9)|Out-Null;$fgT=[CareerOpsForeground]::GetWindowThreadProcessId([CareerOpsForeground]::GetForegroundWindow(),[IntPtr]::Zero);$myT=[CareerOpsForeground]::GetCurrentThreadId();[CareerOpsForeground]::AttachThreadInput($myT,$fgT,$true)|Out-Null;[CareerOpsForeground]::keybd_event(18,0,0,[UIntPtr]::Zero);[CareerOpsForeground]::SetForegroundWindow($h)|Out-Null;[CareerOpsForeground]::BringWindowToTop($h)|Out-Null;[CareerOpsForeground]::SwitchToThisWindow($h,$true);[CareerOpsForeground]::keybd_event(18,0,2,[UIntPtr]::Zero);[CareerOpsForeground]::AttachThreadInput($myT,$fgT,$false)|Out-Null;exit 0}catch{}",
    "      }",
    "    }",
    "  }",
    `  Start-Sleep -Milliseconds ${poll}`,
    "}",
    "exit 1",
  ].join("\n");
}

const DETACHED = { detached: true, stdio: "ignore" };
// powershell 专用：绝不能 detached！Windows 下 detached 等同 DETACHED_PROCESS，
// 控制台应用（powershell.exe）拿不到控制台会启动即静默死亡（2026-09-24 marker
// 实验实测：detached 子进程连第一行日志都写不出来，非 detached 正常跑完）。
// windowsHide 防闪窗，unref 不拖住事件循环；进程树里没有杀子进程的语义，
// 父进程退出不会带走 helper。
const HIDDEN_CONSOLE_CHILD = { stdio: "ignore", windowsHide: true };

// spawn 即发即忘：explorer 成功时也常返回非零退出码（见原路由注释），error
// 事件同样静默吞掉 —— HTTP 响应只陈述 spawn 本身，不陈述窗口的最终状态。
function fireAndForget(spawn, opts, cmd, args) {
  spawn(cmd, args, opts)
    .on("error", () => {})
    .unref();
}

// 在资源管理器中选中 pdfPath 并把所在窗口提到前台。仅 win32 调用；
// spawn 可注入（单测用 mock），其余参数无调用方需要覆盖。
export function revealCvPdfInExplorer(pdfPath, { spawn = nodeSpawn, timeoutMs, pollMs } = {}) {
  // explorer 是 GUI 进程，detached 安全（历史上就是这么 spawn 的，不改）。
  fireAndForget(spawn, DETACHED, "explorer", ["/select," + pdfPath]);
  // helper 必须非 detached（见上），否则永远不执行。
  fireAndForget(spawn, HIDDEN_CONSOLE_CHILD, "powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-Command",
    buildForegroundScript(path.dirname(pdfPath), { timeoutMs, pollMs }),
  ]);
}
