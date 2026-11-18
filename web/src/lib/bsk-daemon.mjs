// 浏览器抓取通道（bsk）的派发前探测。
//
// 2026-11-18 #1360：体检守护进程在宿主的 Job Object 内起不来（不允许 breakaway），
// worker 却照常被派发，最后交了一份「全维未获取到」的体检。可见「这条通道现在能不能
// 用」必须在派发前问一次，而不是留给 worker 在自己的预算里折腾。
//
// 职责边界：这里只**探测**，不启动。启动 daemon 由托盘壳在 Job 之外负责
// （tray-shell/src/bsk-daemon.cjs）——web 服务本身多半也在同一个 Job 里，从这里
// 起 daemon 只会重复 #1360 的失败。
//
// Plain .mjs，node --test 直测（web/tests/lib/bsk-daemon.test.mjs）。

import { execFile } from "node:child_process";

// 与 bsk-extract.mjs 的 DAEMON_PROBE_TIMEOUT_MS 同口径：`bsk status` 是本地 ping，
// 而不是一次抓取，超过这个时间基本就是守护进程卡死。
export const BSK_PROBE_TIMEOUT_MS = 10_000;

// 国内招聘站域名。权威口径在 lib/zh-jobs.mjs（browser-extract / bsk-extract 共用），
// 但 web 构建不跨出 web/ 取模块，所以这里保留同集合副本；测试同时锁定两者口径。
const BSK_BOARD_HOSTS = ["zhipin.com", "kanzhun.com", "liepin.com", "zhaopin.com"];

/**
 * 这条 URL 是否属于「无头/未登录浏览器会被验证墙拦住、只能走 bsk」的招聘站。
 * 与 lib/zh-jobs.mjs 的 isZhJobHost 逐条同口径：全主机名或一级子域命中才算，
 * 解析失败一律 false（不在本判定里猜）。
 * @param {string} url
 * @returns {boolean}
 */
export function isBskBoardUrl(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return BSK_BOARD_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

/** 取一段输出的首个「有内容」的行，截断到 200 字。
 *  跳过只由括号/引号组成的行：bsk 的多行失败输出常以 `{` 开头，那行没有诊断价值。 */
function firstLine(text) {
  const line =
    String(text ?? "")
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s && s.replace(/[{}[\],"]/g, "").length > 0) ?? "";
  return line.slice(0, 200);
}

/**
 * 解析一次 `bsk status --json` 的结果。
 *
 * 三种状态必须分开表达，因为它们的处置不同：
 *   - 守护进程不在（命令非 0 / 非 JSON）→ ok:false, daemon:false
 *   - 守护进程在、但没有浏览器扩展连着 → ok:false, daemon:true
 *   - 两者都在 → ok:true
 *
 * @param {{code?: number|null, stdout?: string, stderr?: string, killed?: boolean}} result
 * @returns {{ok: boolean, daemon: boolean, browsers: number, reason: string}}
 */
export function parseBskStatus({ code, stdout, stderr, killed } = {}) {
  if (killed) {
    return { ok: false, daemon: false, browsers: 0, reason: "bsk status timed out" };
  }
  const text = String(stdout ?? "").replace(/^\uFEFF/, "").trim();
  if (code !== 0) {
    // 失败时 bsk 仍可能把原因写在 stdout 的 JSON 里（exit 2 + {code,message,hint}），
    // 此时 stderr 是空的。优先取 message：它正是「Job Object 不允许 breakaway」这类
    // 可诊断原因；退回去按 stderr 首行取，再退回退出码。
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 的失败输出走下面的首行兜底 */
    }
    const message = parsed?.message ?? parsed?.error;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, daemon: false, browsers: 0, reason: firstLine(message) };
    }
    return {
      ok: false,
      daemon: false,
      browsers: 0,
      reason: firstLine(stderr) || firstLine(stdout) || `bsk status exited with code ${code ?? "unknown"}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      daemon: false,
      browsers: 0,
      reason: text ? `bsk status returned non-JSON: ${text.slice(0, 160)}` : "bsk status returned no output",
    };
  }
  // bsk 0.4+ 的 status 无论本地是否配对过都会带 browsers 数组；数组为空 = 扩展没连上。
  const browsers = Array.isArray(parsed?.browsers) ? parsed.browsers : [];
  const live = browsers.filter((b) => b && b.unresponsive !== true).length;
  return {
    ok: live > 0,
    daemon: true,
    browsers: live,
    reason: live > 0 ? "" : "bsk is up, but no browser extension is connected",
  };
}

/**
 * 探测本机 bsk 通道。默认跑 `bsk status --json`；`run` 可注入，测试不碰真进程。
 *
 * @param {{timeoutMs?: number, run?: Function}} [options]
 * @returns {Promise<{ok: boolean, daemon: boolean, browsers: number, reason: string}>}
 */
export function probeBskDaemon({ timeoutMs = BSK_PROBE_TIMEOUT_MS, run } = {}) {
  const exec =
    run ??
    ((args, options, cb) =>
      execFile("bsk", args, { ...options, timeout: timeoutMs, windowsHide: true }, cb));
  return new Promise((resolve) => {
    exec(["status", "--json"], { timeoutMs }, (err, stdout, stderr) => {
      resolve(
        parseBskStatus({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout,
          stderr,
          killed: Boolean(err?.killed),
        }),
      );
    });
  });
}

/** 派发前拦截的统一错误码 —— 前端按它换本地化文案，不去猜服务端英文原文。 */
export const BSK_UNAVAILABLE_CODE = "bsk-unavailable";

/**
 * 通道不可用时的 409 应答体。`error` 是给批量卡片这类直接展示服务端文案的调用方看的
 * 一句人话；`detail` 带上探测到的真实原因（守护进程不在 vs 浏览器没连）。
 * @param {{daemon: boolean, browsers: number, reason: string}} state
 */
export function bskUnavailableBody(state) {
  const error = state.daemon
    ? "Browser capture (bsk) is up, but no browser extension is connected — connect it, then retry."
    : "Browser capture (bsk) is not running — start browser-skill, then retry.";
  return { error, code: BSK_UNAVAILABLE_CODE, detail: state.reason };
}