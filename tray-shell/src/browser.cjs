"use strict";

// 打开仪表盘时的浏览器复用（工单：反复打包/启动不再叠一长串 localhost:3000 标签）。
//
// 背景：service 就绪后 `openBrowser()` 直接 `shell.openExternal(url)`，Edge 每次都开新标签；
// 每打一次包就多一个，标签栏很快就被同一个地址占满。
//
// 做法：Windows 上先用 UI Automation 读每个 Edge 窗口的地址栏（= 该窗口活动标签的 URL），
// 命中目标地址就 `AppActivate` 把那个窗口切到前台；没命中才真正 openExternal。
// 只读地址栏，不写、不切标签、不关任何窗口/进程——探测本身绝不结束用户的浏览器。
//
// 语义边界：只看「活动标签」。后台标签里的同一个地址探测不到（读它要切过去，代价更高），
// 这种情况仍会开一个新标签——宁可多一个标签，也不动用户正在看的页面。
// 任何一步失败（UIA 被拒、PowerShell 不可用、超时）都退回「直接打开」，绝不静默什么都不做。

const { execFile } = require("node:child_process");

const EDGE_PROCESS = "msedge";

// 端口写死 3000（ADR-0063），这里只关心地址比对，不参与端口决策。
const POWER_SHELL = "powershell";

/**
 * 列出 Edge 各窗口活动标签的地址。
 *
 * 地址栏是窗口 chrome 里最靠上的那个 Edit（页面内的输入框都在它下面），
 * 所以取「值像地址 + Top 最小」的那个；页面里的搜索框（值不像地址）被正则挡掉。
 * 输出一行 JSON 数组：`[{"pid":2612,"url":"localhost:3000/config"}]`。
 */
const SCAN_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes;
$editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit);
$addressLike = '^([a-zA-Z][a-zA-Z0-9+.-]*://)?(localhost|127\\.0\\.0\\.1|[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+)(:\\d+)?([/?#].*)?$';
$rows = @();
foreach ($p in (Get-Process ${EDGE_PROCESS} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$p.MainWindowHandle);
    if (-not $root) { continue }
    $best = $null;
    foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)) {
      $valuePattern = $null;
      if (-not $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) { continue }
      $value = $valuePattern.Current.Value;
      if (-not $value -or $value -notmatch $addressLike) { continue }
      $top = [int]$e.Current.BoundingRectangle.Top;
      if (-not $best -or $top -lt $best.top) { $best = [pscustomobject]@{ pid = $p.Id; url = $value; top = $top } }
    }
    if ($best) { $rows += [pscustomobject]@{ pid = $best.pid; url = $best.url } }
  } catch { }
}
ConvertTo-Json -InputObject @($rows) -Compress
`;

/** 环回地址视作同一台机器：用户可能用 127.0.0.1 打开过仪表盘。 */
const LOOPBACK_HOSTS = new Map([
  ["127.0.0.1", "localhost"],
  ["[::1]", "localhost"],
  ["::1", "localhost"],
]);

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      POWER_SHELL,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: timeoutMs },
      (error, stdout) => resolve(error ? "" : String(stdout || "")),
    );
  });
}

/** 扫描结果的解析（纯函数）：单对象 / 数组 / 空 / 垃圾输入都折成数组。 */
function parseWindowList(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : [data];
  return list
    .map((row) => ({ pid: Number(row && row.pid), url: String((row && row.url) || "") }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.url !== "");
}

/** 地址规范化（纯函数）：省略 scheme 时按 http 处理，环回别名归一，默认端口补齐。 */
function normalizeUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const hostname = LOOPBACK_HOSTS.get(parsed.hostname.toLowerCase()) || parsed.hostname.toLowerCase();
  const fallbackPort = parsed.protocol === "https:" ? "443" : "80";
  return {
    host: `${hostname}:${parsed.port || fallbackPort}`,
    path: parsed.pathname.replace(/\/+$/, ""),
    search: parsed.search,
  };
}

/**
 * 已有标签页的地址是否算「同一个页面」。
 *
 * 目标是仪表盘根地址时比较同源：开着 `/config` 也没必要再开一个根标签页。
 * 目标是具体页面（/pipeline?tab=APPLIED 之类）时必须 path + query 都对上，
 * 否则会把用户正在看的另一个页面当成命中，等于悄悄什么都不打开。
 */
function matchesTarget(existingUrl, targetUrl) {
  const existing = normalizeUrl(existingUrl);
  const target = normalizeUrl(targetUrl);
  if (!existing || !target) return false;
  if (existing.host !== target.host) return false;
  if (target.path === "" && target.search === "") return true;
  return existing.path === target.path && existing.search === target.search;
}

/** 从扫描结果里挑出可复用的窗口（纯函数）。 */
function pickReusableWindow(windows, targetUrl) {
  for (const row of windows || []) {
    if (matchesTarget(row.url, targetUrl)) return row;
  }
  return null;
}

function scanEdgeWindows(timeoutMs = 8000) {
  return runPowerShell(SCAN_SCRIPT, timeoutMs).then(parseWindowList);
}

/**
 * 把 pid 的主窗口切到前台。成功由显式 `ok` 回执判定：runPowerShell 失败时拿到的是空串，
 * 「没有输出」不能当成成功（否则激活失败会静默不回退到 openExternal）。
 * pid 是 Number 且已校验，拼进脚本无注入面。
 */
function activateEdgeWindow(pid, timeoutMs = 5000) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return Promise.resolve(false);
  const script = `$shell = New-Object -ComObject WScript.Shell; if ($shell.AppActivate(${target})) { Write-Output 'ok' } else { throw 'AppActivate failed' }`;
  return runPowerShell(script, timeoutMs).then((stdout) => stdout.trim() === "ok");
}

/**
 * 打开目标地址；Edge 里已有同一个页面就把那个窗口切到前台。
 *
 * @param {string} url 目标地址
 * @param {{platform?: string, openExternal: (url: string) => void,
 *          scanWindows?: () => Promise<Array<{pid: number, url: string}>>,
 *          activateWindow?: (pid: number) => Promise<boolean>}} deps
 * @returns {Promise<{opened: boolean, focused: boolean, pid: number, url: string}>}
 */
async function openOrFocus(url, deps = {}) {
  const { openExternal } = deps;
  if (typeof openExternal !== "function") throw new TypeError("openOrFocus 需要 openExternal 回调");
  const platform = deps.platform || process.platform;
  const scanWindows = deps.scanWindows || (() => scanEdgeWindows());
  const activateWindow = deps.activateWindow || ((pid) => activateEdgeWindow(pid));

  if (platform === "win32") {
    try {
      const hit = pickReusableWindow(await scanWindows(), url);
      if (hit && (await activateWindow(hit.pid))) {
        return { opened: false, focused: true, pid: hit.pid, url: hit.url };
      }
    } catch {
      /* 探测失败 → 照常打开，别把「已经能打开浏览器」变成一条死路 */
    }
  }

  openExternal(url);
  return { opened: true, focused: false, pid: 0, url };
}

module.exports = {
  activateEdgeWindow,
  matchesTarget,
  normalizeUrl,
  openOrFocus,
  parseWindowList,
  pickReusableWindow,
  scanEdgeWindows,
};
