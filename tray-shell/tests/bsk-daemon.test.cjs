"use strict";

// bsk 守护进程保障的行为测试：不碰真 bsk、不碰 WMI、不 spawn 进程。
// 对应 2026-11-18 #1360 的三条事实：Job 内 detached 起不来、前台起会随 shell 死、
// 所以壳只在「探测说不在」时用 WMI 拉起，并等到真正就绪。

const test = require("node:test");
const assert = require("node:assert/strict");
const { statusIsReady, statusFailureReason, buildDaemonCommandLine, buildWmiScript, encodePowerShell, ensureBskDaemon } = require("../src/bsk-daemon.cjs");

function fakeLogs() {
  const lines = [];
  return { lines, line: (source, text) => lines.push(`[${source}] ${text}`) };
}

test("status 就绪判定：成功且 JSON 对象才算，空输出/非 JSON/非零退出都不算", () => {
  assert.equal(statusIsReady({ code: 0, stdout: '{"browsers":[]}' }), true);
  assert.equal(statusIsReady({ code: 0, stdout: '\uFEFF{"browsers":[]}' }), true);
  assert.equal(statusIsReady({ code: 0, stdout: "" }), false);
  assert.equal(statusIsReady({ code: 0, stdout: "not json" }), false);
  assert.equal(statusIsReady({ code: 1, stdout: '{"browsers":[]}' }), false);
});

test("失败原因优先取 stdout JSON 的 message（bsk 的 stderr 是空的）", () => {
  const reason = statusFailureReason({
    code: 2,
    stderr: "",
    stdout: JSON.stringify({
      code: null,
      message: "ensure daemon is running: the Job Object of this process does not allow breakaway",
      exit_code: 2,
    }),
  });
  assert.match(reason, /does not allow breakaway/);
});

test("原因兜底会跳过只有括号的行，不回显一截 JSON", () => {
  assert.equal(statusFailureReason({ code: 1, stdout: "{\n  not json\n", stderr: "" }), "not json");
  assert.equal(statusFailureReason({ code: 1, stdout: "", stderr: "" }), "bsk status exited with code 1");
});

test("CommandLine 给路径加引号（WMI 不分词靠它）", () => {
  assert.equal(buildDaemonCommandLine("C:\\Program Files\\bsk.exe"), '"C:\\Program Files\\bsk.exe" daemon start');
});

test("WMI 脚本：单引号路径被转义，ReturnValue 非 0 时明确失败", () => {
  const script = buildWmiScript(`"C:\\Users\\o'neil\\bsk.exe" daemon start`);
  assert.ok(script.includes(`$cmd = '"C:\\Users\\o''neil\\bsk.exe" daemon start'`), script);
  assert.match(script, /ReturnValue -ne 0/);
  assert.match(script, /exit 1/);
  assert.match(script, /Write-Output \$r\.ProcessId/);
});

test("EncodedCommand 是 UTF-16LE base64", () => {
  const encoded = encodePowerShell("Write-Output 1");
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), "Write-Output 1");
});

test("已就绪：不启动 daemon", async () => {
  const logs = fakeLogs();
  let started = 0;
  const result = await ensureBskDaemon({
    logs,
    probe: async () => ({ ready: true, reason: "" }),
    startDaemon: async () => {
      started += 1;
      return { ok: true };
    },
  });
  assert.deepEqual(result, { ok: true, started: false, reason: "" });
  assert.equal(started, 0);
  assert.match(logs.lines.join("\n"), /就绪/);
});

test("未就绪：WMI 拉起后轮询到就绪", async () => {
  const logs = fakeLogs();
  const probes = [{ ready: false, reason: "daemon offline" }, { ready: false, reason: "starting" }, { ready: true, reason: "" }];
  let started = 0;
  const result = await ensureBskDaemon({
    logs,
    probe: async () => probes.shift() ?? { ready: true, reason: "" },
    findBinary: async () => "C:\\bsk.exe",
    startDaemon: async () => {
      started += 1;
      return { ok: true, pid: 4242 };
    },
    sleep: async () => {},
    retryIntervalMs: 0,
    readyTimeoutMs: 10_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(started, 1);
  assert.match(logs.lines.join("\n"), /pid 4242/);
});

test("找不到 bsk：不尝试启动，且日志点名原因", async () => {
  const logs = fakeLogs();
  let started = 0;
  const result = await ensureBskDaemon({
    logs,
    probe: async () => ({ ready: false, reason: "offline" }),
    findBinary: async () => "",
    startDaemon: async () => {
      started += 1;
      return { ok: true };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(started, 0);
  assert.match(logs.lines.join("\n"), /找不到 bsk 可执行文件/);
});

test("WMI 启动失败：原因写进日志与返回值", async () => {
  const logs = fakeLogs();
  const result = await ensureBskDaemon({
    logs,
    probe: async () => ({ ready: false, reason: "offline" }),
    findBinary: async () => "C:\\bsk.exe",
    startDaemon: async () => ({ ok: false, reason: "WMI Create returned 5" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "WMI Create returned 5");
  assert.match(logs.lines.join("\n"), /启动失败：WMI Create returned 5/);
});

test("轮询超时：如实标记失败，不把『已启动』当『已就绪』", async () => {
  const logs = fakeLogs();
  let clock = 0;
  const result = await ensureBskDaemon({
    logs,
    probe: async () => ({ ready: false, reason: "starting" }),
    findBinary: async () => "C:\\bsk.exe",
    startDaemon: async () => ({ ok: true, pid: 7 }),
    // 每次 sleep 把时钟推过 deadline，循环必然结束
    sleep: async () => {
      clock += 60_000;
    },
    readyTimeoutMs: 1_000,
    retryIntervalMs: 1_500,
    now: () => clock,
  });
  assert.equal(result.ok, false);
  assert.equal(result.started, true);
  assert.match(logs.lines.join("\n"), /启动超时/);
});