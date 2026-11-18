"use strict";

// bsk 守护进程的宿主侧保障（2026-11-18 #1360）。
//
// 背景：Windows 上 agent 宿主（CodeArts、codebuddy 的 shell 工具，以及本机 web
// 派发给 worker 的那条链路）会给命令套一个**不允许 breakaway** 的 Job Object。
// bsk 客户端自动起守护进程走 detached CreateProcess，必然被拒（os error 5）；
// `bsk daemon start` 在前台跑又会随那次 shell 调用一起消失，下一个 worker 只看到
// 「无法启动」。所以 daemon 必须由一个**不在那个 Job 里**的进程拉起并常驻。
//
// 托盘壳由 Explorer/Dock 启动，本身不在 agent 的 Job 里；这里用 WMI 再退一层
// （进程父级是 Wmiprvse.exe）启动 `bsk daemon start`，并轮询到就绪。web 侧只探测
// 与连接，不自己启动（web/src/lib/bsk-daemon.mjs）——它多半就在同一 Job 里。
//
// 失败要写进 launcher.log 且不阻塞壳启动：daemon 起不来影响的是体检/国内招聘站
// 抓取，不是托盘本身。

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFile } = require("node:child_process");

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_500;
const WMI_TIMEOUT_MS = 20_000;

/**
 * 一次 `bsk status --json` 的输出是否说明守护进程就绪。
 *
 * 这里只认「命令成功 + 输出是 JSON 对象」，不要求浏览器扩展已连接：浏览器没连是
 * 用户侧待解决的事，重新拉起 daemon 不会让它连上，只会多一次无意义的重启。
 * 浏览器是否在线的判断属于派发前门禁（web 侧）。
 *
 * @param {{code?: number|null, stdout?: string}} result
 * @returns {boolean}
 */
function statusIsReady({ code, stdout } = {}) {
  if (code !== 0) return false;
  const text = String(stdout ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed) && typeof parsed === "object";
  } catch {
    return false;
  }
}

/** `"<bsk.exe>" daemon start` —— WMI CommandLine 需要把带空格的路径整体加引号。 */
function buildDaemonCommandLine(bskPath) {
  return `"${String(bskPath)}" daemon start`;
}

/**
 * WMI 启动脚本。CommandLine 放进 PowerShell 单引号字面量，路径里的 `'` 按 PS 规则
 * 转成 `''`；ReturnValue 非 0（拒绝访问/无效参数等）显式写到 stderr 并退出 1，
 * 让调用方能拿到真实原因而不是一个空 pid。
 */
function buildWmiScript(commandLine) {
  const literal = `'${String(commandLine).replace(/'/g, "''")}'`;
  return [
    `$cmd = ${literal}`,
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }",
    'if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("WMI Create returned " + $r.ReturnValue); exit 1 }',
    "Write-Output $r.ProcessId",
  ].join("\n");
}

/** PowerShell -EncodedCommand 要求 UTF-16LE base64：彻底绕开多平台引号差异。 */
function encodePowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

/** 在 PATH 里找 bsk；找不到再退回 browser-skill 的默认安装位置。 */
async function findBskBinary({ where = runWhere, existsSync = fs.existsSync } = {}) {
  const fromPath = await where("bsk");
  if (fromPath) return fromPath;
  const fallback = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "bsk.exe" : "bsk");
  return existsSync(fallback) ? fallback : "";
}

function runWhere(name) {
  return new Promise((resolve) => {
    execFile("where", [name], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve("");
      const first = String(stdout ?? "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      resolve(first || "");
    });
  });
}

/** 首个「有内容」的行（跳过只有括号/引号的行）。失败原因要能进 launcher.log。 */
function firstLine(text) {
  const line =
    String(text ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && s.replace(/[{}[\],"]/g, "").length > 0) ?? "";
  return line.slice(0, 200);
}

/**
 * 失败时的可诊断原因。bsk 的 `status --json` 失败时把原因写在 stdout 的 JSON
 * （`{code, message, hint, exit_code}`），stderr 反而是空的 —— 直接取 stderr 首行
 * 会退化成「exited with code 2」，日志就白写了。
 * @param {{stdout?: string, stderr?: string, code?: number|null}} result
 */
function statusFailureReason({ stdout, stderr, code } = {}) {
  const text = String(stdout ?? "").replace(/^\uFEFF/, "").trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.message ?? parsed?.error;
      if (typeof message === "string" && message.trim()) return firstLine(message);
    } catch {
      /* 非 JSON 的失败输出走首行兜底 */
    }
  }
  return firstLine(stderr) || firstLine(stdout) || `bsk status exited with code ${code ?? "unknown"}`;
}

/** 跑一次 status；任何失败都收敛成 { ready, reason }，不抛。 */
function defaultProbe({ timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile("bsk", ["status", "--json"], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err?.killed) return resolve({ ready: false, reason: "bsk status timed out" });
      if (err) {
        return resolve({ ready: false, reason: statusFailureReason({ stdout, stderr, code: err.code }) });
      }
      if (!statusIsReady({ code: 0, stdout })) {
        return resolve({ ready: false, reason: "bsk status returned an unexpected payload" });
      }
      resolve({ ready: true, reason: "" });
    });
  });
}

/**
 * 在 Job 之外启动 daemon（WMI 的父进程是 Wmiprvse.exe）。
 * @returns {Promise<{ok: boolean, pid?: number, reason?: string}>}
 */
function startDaemonOutsideJob(bskPath) {
  const script = buildWmiScript(buildDaemonCommandLine(bskPath));
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
      { timeout: WMI_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const reason =
            String(stderr ?? "")
              .split("\n")
              .map((s) => s.trim())
              .find(Boolean) ?? err.message;
          return resolve({ ok: false, reason: reason.slice(0, 200) });
        }
        const pid = Number(String(stdout ?? "").trim());
        resolve(Number.isFinite(pid) && pid > 0 ? { ok: true, pid } : { ok: false, reason: "WMI returned no pid" });
      },
    );
  });
}

/**
 * 确保 bsk 守护进程可用：探一次，不在就 WMI 拉起，然后轮询到 readyTimeoutMs。
 *
 * 依赖全部可注入（probe / findBinary / startDaemon / sleep），测试不碰真进程。
 * @param {{logs?: {line: Function}, probe?: Function, findBinary?: Function, startDaemon?: Function,
 *          sleep?: Function, readyTimeoutMs?: number, retryIntervalMs?: number}} [options]
 * @returns {Promise<{ok: boolean, started: boolean, reason: string}>}
 */
async function ensureBskDaemon(options = {}) {
  const logs = options.logs ?? null;
  const log = (text) => {
    try {
      logs?.line?.("launcher", text);
    } catch {
      /* 日志写失败不能冒泡：daemon 保障不该拖垮托盘 */
    }
  };
  const probe = options.probe ?? defaultProbe;
  const findBinary = options.findBinary ?? findBskBinary;
  const startDaemon = options.startDaemon ?? startDaemonOutsideJob;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  // 时钟可注入只为测试把「超时」压缩到毫秒级，运行期永远是 Date.now()。
  const now = options.now ?? Date.now;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  const first = await probe();
  if (first.ready) {
    log("bsk 守护进程就绪");
    return { ok: true, started: false, reason: "" };
  }

  const bin = await findBinary();
  if (!bin) {
    const reason = "找不到 bsk 可执行文件（PATH 与 ~/.local/bin 都没有）";
    log(`bsk 守护进程不可用：${reason}；体检与国内招聘站抓取会失败`);
    return { ok: false, started: false, reason };
  }

  log(`bsk 守护进程不可用（${first.reason || "unknown"}），在 Job 外启动：${bin}`);
  const started = await startDaemon(bin);
  if (!started.ok) {
    const reason = started.reason || "unknown";
    log(`bsk 守护进程启动失败：${reason}；体检与国内招聘站抓取会失败`);
    return { ok: false, started: false, reason };
  }

  const deadline = now() + readyTimeoutMs;
  let lastReason = first.reason || "unknown";
  while (now() <= deadline) {
    const current = await probe();
    lastReason = current.reason || lastReason;
    if (current.ready) {
      log(`bsk 守护进程已就绪（pid ${started.pid ?? "?"}）`);
      return { ok: true, started: true, reason: "" };
    }
    await sleep(retryIntervalMs);
  }

  const reason = `${Math.round(readyTimeoutMs / 1000)}s 内未就绪（最后一次：${lastReason}）`;
  log(`bsk 守护进程启动超时：${reason}；体检与国内招聘站抓取会失败`);
  return { ok: false, started: true, reason };
}

module.exports = {
  statusIsReady,
  statusFailureReason,
  buildDaemonCommandLine,
  buildWmiScript,
  encodePowerShell,
  findBskBinary,
  ensureBskDaemon,
};