"use strict";

// 打开仪表盘时的浏览器复用（工单：反复打包/启动不再叠一长串 localhost:3000 标签）。
//
// 背景：service 就绪后 `openBrowser()` 直接 `shell.openExternal(url)`，Edge 每次都开新标签；
// 每打一次包就多一个，标签栏很快就被同一个地址占满。
//
// 做法（Windows，UI Automation；全程只读 + 至多「切一下标签」）：
//   1. 读每个 Edge 窗口的地址栏（= 该窗口**活动**标签的 URL），命中目标地址就
//      `AppActivate` 把那个窗口切到前台——不碰标签。
//   2. 活动标签没命中，再看窗口的标签条（UIA `TabItem` 的 Name = 标签标题 + 选中态），
//      挑标题像本仪表盘的标签选中它，把地址栏的真实 URL 读回来核对：对上了就停在这个
//      标签上；对不上就把原来的标签切回去，再试下一个候选（最多 MAX_TAB_PROBES 个）。
//   3. 都没命中才真正 openExternal。
// 不关任何窗口/进程——探测本身绝不结束用户的浏览器。
//
// 为什么标题只是「候选」而不是判据：TabItem 只暴露标题、不暴露 URL，所以先用标题筛，
// 再用地址栏把 URL 读回来核对。这样标题撞车（比如同名的 GitHub 仓库页）也不会误切，
// 也不必把每个后台标签都闪一遍。品牌词默认从目标页的 <title> 首段推出来（brandTokensFor），
// 抓不到才退回常量，不去猜站点的标题规则。
// 任何一步失败（UIA 被拒、PowerShell 不可用、超时）都退回「直接打开」，绝不静默什么都不做。

const { execFile } = require("node:child_process");

const EDGE_PROCESS = "msedge";

// 端口写死 3000（ADR-0063），这里只关心地址比对，不参与端口决策。
const POWER_SHELL = "powershell";

/** 像地址的字符串（页面里的搜索框值不像地址，被这条挡掉）。 */
const ADDRESS_LIKE = '^([a-zA-Z][a-zA-Z0-9+.-]*://)?(localhost|127\\.0\\.0\\.1|[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+)(:\\d+)?([/?#].*)?$';

// 后台标签最多试几个：标题命中的每一个都要切过去读 URL，试太多会闪得人眼花。
const MAX_TAB_PROBES = 3;

// 取不到目标页 <title> 时的品牌词兜底（= web/src/app/layout.tsx 的 metadata.title 首段）。
const DEFAULT_BRAND_TOKEN = "career-ops";

/**
 * 列出 Edge 各窗口：活动标签的地址（url）+ 标签条（tabs）。
 *
 * 地址栏是窗口 chrome 里最靠上的那个 Edit（页面内的输入框都在它下面），
 * 所以取「值像地址 + Top 最小」的那个；页面里的搜索框（值不像地址）被正则挡掉。
 * 标签条里的 `TabItem` 只暴露标题（Name）与选中态，没有 URL——所以才要选中后再回读地址栏。
 * 输出一行 JSON：`[{"pid":2612,"url":"qoder.com.cn/cli","tabs":[{"index":0,"title":"career-ops — official web experience","selected":false}]}]`。
 */
const SCAN_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes;
$editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit);
$tabCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem);
$addressLike = '${ADDRESS_LIKE}';
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
      if (-not $best -or $top -lt $best.top) { $best = [pscustomobject]@{ url = $value; top = $top } }
    }
    $tabs = @();
    $i = 0;
    foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)) {
      $selected = $false;
      $selPattern = $null;
      if ($t.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selPattern)) { $selected = $selPattern.Current.IsSelected }
      $tabs += [pscustomobject]@{ index = $i; title = $t.Current.Name; selected = $selected };
      $i++;
    }
    if ($best -or $tabs.Count -gt 0) {
      $rows += [pscustomobject]@{ pid = $p.Id; url = $(if ($best) { $best.url } else { '' }); tabs = @($tabs) };
    }
  } catch { }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 5
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

/** 切换标签的脚本：选中第 index 个 TabItem，然后把它（= 活动标签）的地址读回来。 */
function selectTabScript(pid, index) {
  return `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes;
$editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit);
$tabCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem);
$addressLike = '${ADDRESS_LIKE}';
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr](Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle);
if (-not $root) { throw 'no window' }
$tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond);
if (${index} -ge $tabs.Count) { throw 'tab index out of range' }
$selPattern = $null;
if (-not $tabs[${index}].TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selPattern)) { throw 'tab not selectable' }
$selPattern.Select();
Start-Sleep -Milliseconds 180;
$best = $null;
foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)) {
  $valuePattern = $null;
  if (-not $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) { continue }
  $value = $valuePattern.Current.Value;
  if (-not $value -or $value -notmatch $addressLike) { continue }
  $top = [int]$e.Current.BoundingRectangle.Top;
  if (-not $best -or $top -lt $best.top) { $best = [pscustomobject]@{ url = $value; top = $top } }
}
if ($best) { Write-Output $best.url }
`;
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
    .map((row) => ({
      pid: Number(row && row.pid),
      url: String((row && row.url) || ""),
      tabs: parseTabs(row && row.tabs),
    }))
    // 没地址但有标签条也要留着：后台标签命中正是靠它
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && (row.url !== "" || row.tabs.length > 0));
}

/** 标签条解析（纯函数）：PS 5.1 单元素会折成对象，这里统一成数组。 */
function parseTabs(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((tab, position) => ({
      index: Number.isInteger(Number(tab && tab.index)) ? Number(tab.index) : position,
      title: String((tab && tab.title) || ""),
      selected: Boolean(tab && tab.selected),
    }))
    .filter((tab) => tab.index >= 0);
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
 * 选中某个窗口的第 index 个标签，返回它（= 新的活动标签）的地址；没读到给空串。
 * pid / index 都是 Number 且已校验，拼进脚本无注入面。
 */
function selectEdgeTab(pid, index, timeoutMs = 6000) {
  const target = Number(pid);
  const slot = Number(index);
  if (!Number.isInteger(target) || target <= 0 || !Number.isInteger(slot) || slot < 0) return Promise.resolve("");
  return runPowerShell(selectTabScript(target, slot), timeoutMs).then((stdout) => String(stdout || "").trim());
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

/** 目标页 <title> 的首段当品牌词：`career-ops — official web experience` → `career-ops`。 */
function brandTokenFromTitle(title) {
  const head = String(title || "")
    .split(/\s+[—–|·-]\s+/)[0]
    .trim();
  return head.length >= 3 ? head.toLowerCase() : "";
}

/**
 * 品牌词候选：抓目标页 HTML 的 <title> 首段；抓不到（服务没起、超时）就退回常量。
 * 返回小写数组，供标签标题 include 比对。
 */
async function brandTokensFor(targetUrl, timeoutMs = 1200) {
  const tokens = [];
  try {
    const rootUrl = new URL("/", targetUrl).href;
    const response = await fetch(rootUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) {
      const html = await response.text();
      const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const token = brandTokenFromTitle(match && match[1]);
      if (token) tokens.push(token);
    }
  } catch {
    /* 取不到标题就不猜，用下面的兑底 */
  }
  if (tokens.length === 0) tokens.push(DEFAULT_BRAND_TOKEN);
  return tokens;
}

/** 标签标题是不是像目标站（纯函数）。 */
function tabTitleMatches(title, tokens) {
  const text = String(title || "").toLowerCase();
  if (!text) return false;
  return (tokens || []).some((token) => token && text.includes(String(token).toLowerCase()));
}

/**
 * 从扫描结果里挑出「可以试试」的后台标签（纯函数）。
 *
 * 只按标题筛（UIA 不提供后台标签的 URL），每个候选带上同窗口当前选中标签的 index，
 * 核对不上时好切回去。最多 limit 个：每个候选都要真切一次标签。
 */
function pickCandidateTabs(windows, tokens, limit = MAX_TAB_PROBES) {
  const candidates = [];
  for (const window of windows || []) {
    const tabs = (window && window.tabs) || [];
    const selected = tabs.find((tab) => tab.selected);
    const restoreIndex = selected ? selected.index : null;
    for (const tab of tabs) {
      if (candidates.length >= limit) return candidates;
      if (!tabTitleMatches(tab.title, tokens)) continue;
      candidates.push({ pid: window.pid, index: tab.index, restoreIndex, title: tab.title });
    }
  }
  return candidates;
}

/**
 * 打开目标地址；Edge 里已有同一个页面就把那个窗口切到前台。
 *
 * 先看各窗口的**活动**标签（读地址栏，不碰标签）；没命中再按标题挑候选的后台标签，
 * 选中它把 URL 读回来核对——对上了就停在那个标签上，对不上切回原标签再继续。
 *
 * @param {string} url 目标地址
 * @param {{platform?: string, openExternal: (url: string) => void,
 *          scanWindows?: () => Promise<Array<{pid: number, url: string, tabs?: Array<{index: number, title: string, selected: boolean}>}>>,
 *          activateWindow?: (pid: number) => Promise<boolean>,
 *          selectTab?: (pid: number, index: number) => Promise<string>,
 *          brandTokens?: () => Promise<string[]>, maxProbes?: number}} deps
 * @returns {Promise<{opened: boolean, focused: boolean, pid: number, url: string, backgroundTab: boolean}>}
 */
async function openOrFocus(url, deps = {}) {
  const { openExternal } = deps;
  if (typeof openExternal !== "function") throw new TypeError("openOrFocus 需要 openExternal 回调");
  const platform = deps.platform || process.platform;
  const scanWindows = deps.scanWindows || (() => scanEdgeWindows());
  const activateWindow = deps.activateWindow || ((pid) => activateEdgeWindow(pid));
  const selectTab = deps.selectTab || ((pid, index) => selectEdgeTab(pid, index));

  if (platform === "win32") {
    try {
      const windows = await scanWindows();
      const hit = pickReusableWindow(windows, url);
      if (hit && (await activateWindow(hit.pid))) {
        return { opened: false, focused: true, pid: hit.pid, url: hit.url, backgroundTab: false };
      }

      // 活动标签没命中：翻标签条找后台的那个页面
      if (windows.some((window) => (window.tabs || []).length > 0)) {
        const tokens = await (deps.brandTokens ? deps.brandTokens() : brandTokensFor(url));
        for (const candidate of pickCandidateTabs(windows, tokens, deps.maxProbes || MAX_TAB_PROBES)) {
          const found = await selectTab(candidate.pid, candidate.index);
          if (matchesTarget(found, url)) {
            if (await activateWindow(candidate.pid)) {
              return { opened: false, focused: true, pid: candidate.pid, url: found, backgroundTab: true };
            }
            break; // 标签已经停在对的页面上，只是窗口没抢到前台，别再开新标签
          }
          if (Number.isInteger(candidate.restoreIndex) && candidate.index !== candidate.restoreIndex) {
            await selectTab(candidate.pid, candidate.restoreIndex); // 不是它，把用户原来的标签切回去
          }
        }
      }
    } catch {
      /* 探测失败 → 照常打开，别把「已经能打开浏览器」变成一条死路 */
    }
  }

  openExternal(url);
  return { opened: true, focused: false, pid: 0, url, backgroundTab: false };
}

module.exports = {
  activateEdgeWindow,
  brandTokenFromTitle,
  brandTokensFor,
  matchesTarget,
  normalizeUrl,
  openOrFocus,
  parseTabs,
  parseWindowList,
  pickCandidateTabs,
  pickReusableWindow,
  scanEdgeWindows,
  selectEdgeTab,
  tabTitleMatches,
};
