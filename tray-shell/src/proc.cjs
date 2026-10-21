"use strict";

// 端口 / 进程 / HTTP 探测的薄封装（工单 02）。
//
// 纯解析函数（parseNetstatListening / parseImageName）单独导出，让「按端口精确取 PID」
// 这条规则可以被单测钉住 —— 按进程名匹配会误杀用户的编辑器（ADR-0063）。
// 所有子进程调用都是 execFile + windowsHide，不经 shell（引号/变量插值在这里没有收益）。

const http = require("node:http");
const net = require("node:net");
const { execFile } = require("node:child_process");

const LOOPBACK = "127.0.0.1";

/** TCP 探测：只判断端口有没有进程在听。 */
function isPortListening(port, timeout = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, LOOPBACK);
  });
}

/** 端口能否在本机 IPv4 环回上绑定 —— 与服务的 HOSTNAME=127.0.0.1 对齐。 */
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, LOOPBACK, () => {
      server.close(() => resolve(true));
    });
  });
}

/** 轮询等待端口空出来（覆盖 taskkill 之后的短暂 TIME_WAIT）。 */
async function waitPortFree(port, timeoutMs = 10_000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portFree(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * HTTP GET 一个 JSON 路径，返回 `{ok, status, json, ms, error?}`（ms 就是面板上的「健康 xx ms」）。
 * 永不抛：超时/连接失败都折成 ok:false，并带上 `error` 码——否则「接口拿不到」只能看到 status=0。
 */
function httpJson(port, urlPath, timeout = 1500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get({ host: LOOPBACK, port, path: urlPath, timeout, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, ms: Date.now() - started });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, json: null, ms: Date.now() - started, error: "timeout" });
    });
    req.on("error", (error) => resolve({ ok: false, status: 0, json: null, ms: Date.now() - started, error: error.code || error.message }));
  });
}

/** 旧式健康探测：只看 /api/version 是否 200（接管链第一步）。 */
async function httpAlive(port, timeout = 1500) {
  const res = await httpJson(port, "/api/version", timeout);
  return res.ok;
}

/**
 * 从 `netstat -ano -p TCP` 的输出里，按「端口 + LISTENING」取监听 PID。
 * 纯函数：不按进程名/路径匹配，避免误杀无关进程。
 *
 * @param {string} stdout
 * @param {number} port
 * @returns {number} 0 表示没人监听
 */
function parseNetstatListening(stdout, port) {
  const suffix = `:${port}`;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    // 列：Proto  Local Address  Foreign Address  State  PID
    if (!parts[1].endsWith(suffix)) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return 0;
}

/** `tasklist /FI "PID eq N" /NH` 的第一列就是镜像名（解析失败给空串，PID 本身仍可操作）。 */
function parseImageName(stdout) {
  const fields = String(stdout || "").trim().split(/\s+/);
  return fields.length > 0 ? fields[0] : "";
}

function execText(file, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout) => {
      resolve(err ? "" : String(stdout || ""));
    });
  });
}

/** 端口 → 监听者 `{pid, image}`（pid 0 表示空闲）。 */
async function listenerOf(port) {
  const stdout = await execText("netstat", ["-ano", "-p", "TCP"]);
  const pid = parseNetstatListening(stdout, port);
  if (!pid) return { pid: 0, image: "" };
  const list = await execText("tasklist", ["/FI", `PID eq ${pid}`, "/NH"]);
  return { pid, image: parseImageName(list) };
}

/** 结束 PID 及其子进程树（服务可能带子进程；与 start-web.cmd 的 /T /F 语义一致）。 */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve(false);
      return;
    }
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => resolve(!err));
  });
}

module.exports = {
  LOOPBACK,
  httpAlive,
  httpJson,
  isPortListening,
  killTree,
  listenerOf,
  parseImageName,
  parseNetstatListening,
  portFree,
  waitPortFree,
};
