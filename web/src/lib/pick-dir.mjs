import { execFile } from "node:child_process";

// 「点击选择安装目录」的系统原生对话框（ADR-0097 决议 9）。
//
// 为什么必须由服务端弹：页面上能拿到的目录都不带盘符 —— `<input webkitdirectory>`
// 只给 `File.webkitRelativePath`，`showDirectoryPicker()` 只给 FileSystemDirectoryHandle。
// 而这里要存进 `cliDirs` 的是给 `spawn` 用的绝对路径，`D:\tools\claude` 这个前缀
// 浏览器永远不告诉你。所以对话框只能由**本机进程**弹：仪表盘服务本身就跑在用户
// 桌面会话里，它弹的框和用户在资源管理器里点的是同一个。
//
// 取舍：只做 Windows。其余平台返回 `unsupported`，界面如实让用户粘贴路径——没有
// 验证过的平台分支是负债，不是功能（见 ADR-0097 决议 9）。

/** 对话框最长等多久：用户可能开着去倒杯水，但请求不能永远挂着。 */
const PICK_TIMEOUT_MS = 180_000;

/**
 * 脚本只输出 ASCII 安全的三种回执：
 *   `OK:<base64(utf8 绝对路径)>` · `CANCEL` · `FAIL:<原因>`
 *
 * 路径走 base64 而不是直接 `Write-Output $path`：PowerShell 5.1 往管道写非 ASCII 时
 * 编码取决于控制台代码页，中文/日文目录名会变成乱码——而那正是这个功能最需要
 * 正确处理的输入。起始目录用环境变量传入，避开命令行引号与转义（`Program Files` 之类）。
 *
 * **必须给 `ShowDialog()` 一个 owner 窗口**：实测无 owner 时它不弹框、直接返回
 * Cancel——用户看到的就是「点了没反应」。owner 是一个 1×1、全透明、不上任务栏的
 * 隐藏 Form，只负责让对话框成为它的模态子窗口并置前；它自己永远不可见。
 *
 * `$ProgressPreference` / `-NonInteractive` 都只为「别在用户屏幕上闪东西」，
 * 不影响 WinForms 模态框本身。
 */
export const PICK_SCRIPT = `
$ProgressPreference = 'SilentlyContinue';
$owner = $null;
try {
  Add-Type -AssemblyName System.Windows.Forms;
  $owner = New-Object System.Windows.Forms.Form;
  $owner.Text = 'career-ops';
  $owner.FormBorderStyle = 'None';
  $owner.ShowInTaskbar = $false;
  $owner.Opacity = 0;
  $owner.Size = New-Object System.Drawing.Size(1, 1);
  $owner.StartPosition = 'CenterScreen';
  $owner.TopMost = $true;
  $owner.Show();

  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog;
  $dialog.ShowNewFolderButton = $true;
  $start = $env:CAREER_OPS_PICK_START;
  if ($start -and $start.Trim().Length -gt 0) {
    try { $dialog.SelectedPath = $start.Trim() } catch { }
  }
  $result = $dialog.ShowDialog($owner);
  if ($result -eq 'OK' -and $dialog.SelectedPath) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath);
    Write-Output ('OK:' + [Convert]::ToBase64String($bytes));
  } else {
    Write-Output 'CANCEL';
  }
  $dialog.Dispose();
} catch {
  Write-Output ('FAIL:' + $_.Exception.Message);
} finally {
  if ($owner) { $owner.Close(); $owner.Dispose(); }
}
`.trim();

/** 起始目录的环境变量名（与 PICK_SCRIPT 里的读取处同源）。 */
export const PICK_START_ENV = "CAREER_OPS_PICK_START";

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PICK_SCRIPT];

/**
 * 默认执行器：跑 PowerShell 并拿回 stdout。
 * 注入点存在只为可测——真实调用不了，也不能靠「跑一次看有没有弹窗」来回归。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs: number, env: Record<string, string>}} opts
 * @returns {Promise<{stdout: string, error: (Error & {killed?: boolean}) | null}>}
 */
function runPowerShell(command, args, { timeoutMs, env }) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs, env: { ...process.env, ...env } }, (error, stdout) => {
      resolve({ stdout: String(stdout || ""), error: error || null });
    });
  });
}

/**
 * 解析脚本输出（纯函数）。
 *
 * 顺序有意义：`FAIL:` 也可能带着非零退出码，所以先认显式回执，再看进程结果；
 * 空输出才归到超时/起不来——「没说话」不能当成「用户取消」。
 *
 * @param {string} stdout
 * @param {(Error & {killed?: boolean}) | null} [error]
 * @returns {{status: "picked", dir: string} | {status: "cancelled"} | {status: "failed", reason: string}}
 */
export function decodePickerOutput(stdout, error = null) {
  const text = String(stdout || "");
  const picked = text.match(/OK:([A-Za-z0-9+/=]+)/);
  if (picked) {
    const dir = Buffer.from(picked[1], "base64").toString("utf8").trim();
    return dir ? { status: "picked", dir } : { status: "failed", reason: "empty-path" };
  }
  if (/\bCANCEL\b/.test(text)) return { status: "cancelled" };
  const failed = text.match(/FAIL:([\s\S]+)/);
  if (failed) return { status: "failed", reason: failed[1].trim().slice(0, 200) };
  if (error) return { status: "failed", reason: error.killed ? "timeout" : "spawn-failed" };
  return { status: "failed", reason: "no-output" };
}

/**
 * 目录选择器工厂。
 *
 * `busy` 是闭包内状态而不是模块级变量：同一时刻只允许一个系统对话框——用户连点
 * 两下会得到两个模态框，第二个还无处可关。工厂化让测试能各自持有一份，互不串味。
 *
 * @param {{run?: typeof runPowerShell, platform?: string, timeoutMs?: number}} [opts]
 */
export function createDirectoryPicker({ run = runPowerShell, platform = process.platform, timeoutMs = PICK_TIMEOUT_MS } = {}) {
  let busy = false;
  return {
    /**
     * @param {{start?: string}} [opts] start = 上次填的目录，作为对话框的初始位置
     * @returns {Promise<{status: "picked", dir: string} | {status: "cancelled"} |
     *   {status: "unsupported", reason: string} | {status: "busy"} |
     *   {status: "failed", reason: string}>}
     */
    async pick({ start = "" } = {}) {
      if (busy) return { status: "busy" };
      if (platform !== "win32") return { status: "unsupported", reason: "platform" };
      busy = true;
      try {
        const trimmed = typeof start === "string" ? start.trim() : "";
        const { stdout, error } = await run("powershell", POWERSHELL_ARGS, {
          timeoutMs,
          env: { [PICK_START_ENV]: trimmed },
        });
        return decodePickerOutput(stdout, error);
      } catch {
        // 受限环境（杀软、父进程的作业对象、策略）会在 spawn 这一步直接抛 EPERM。
        // 抛出去就变成 500 + 一句堆栈：界面上什么都不出现，而用户能做的事只有
        // 「自己粘路径」——所以落成和超时同级的结构化回执，让按钮旁边说清这一点。
        return { status: "failed", reason: "spawn-failed" };
      } finally {
        busy = false;
      }
    },
  };
}

/** 服务端默认实例（route 直接用这一个；busy 因此是进程级的）。 */
export const pickDirectory = createDirectoryPicker();

export { PICK_TIMEOUT_MS, POWERSHELL_ARGS };
