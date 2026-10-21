"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLineSink, drainCompleteLines, formatLogLine } = require("../src/logger.cjs");

/** 写文件是异步的（createWriteStream 先 open 再 write）：轮询到落盘为止，避免固定 sleep 的抖动。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 日志同时写 stdout；测试里静音，避免把断言输出淹掉。 */
function quiet(fn) {
  const original = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return fn();
  } finally {
    process.stdout.write = original;
  }
}

test("行格式与旧 Go 契约一致：`[HH:MM:SS] [source] text`", () => {
  assert.equal(formatLogLine("09:05:07", "launcher", "launcher 启动"), "[09:05:07] [launcher] launcher 启动\n");
  assert.equal(formatLogLine("00:00:00", "server", "x"), "[00:00:00] [server] x\n");
});

test("跨块切行：不粘行、不撕行，残行留到下一块", () => {
  const first = drainCompleteLines("第一行\r\n第二");
  assert.deepEqual(first.lines, ["第一行"]);
  assert.equal(first.rest, "第二");

  const second = drainCompleteLines(first.rest + "行\n");
  assert.deepEqual(second.lines, ["第二行"]);
  assert.equal(second.rest, "");
});

test("写文件：启动截断、前缀正确", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-tray-log-"));
  try {
    const logFile = path.join(dir, ".career-ops-web", "launcher.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, "上一次运行的残留\n");

    const sink = quiet(() => {
      const created = createLineSink({ careerRoot: dir });
      created.line("launcher", "launcher 启动：pid=1");
      created.line("server", "ready on 3000");
      return created;
    });
    const read = () => fs.readFileSync(logFile, "utf8");
    const written = await waitFor(() => {
      try {
        const text = read();
        return text.includes("launcher 启动：pid=1") && text.includes("ready on 3000");
      } catch {
        return false;
      }
    });
    assert.ok(written, "两条日志应在 3s 内落盘");

    const text = read();
    quiet(() => sink.close());
    assert.equal(text.includes("上一次运行的残留"), false, "启动必须截断旧文件");
    assert.match(text, /^\[\d{2}:\d{2}:\d{2}\] \[launcher\] launcher 启动：pid=1\n/);
    assert.match(text, /\[\d{2}:\d{2}:\d{2}\] \[server\] ready on 3000\n/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("环形缓冲：tail 按 seq 增量、清屏只推水位不删文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-tray-ring-"));
  try {
    quiet(() => {
      const sink = createLineSink({ careerRoot: dir, ringSize: 3 });
      sink.line("launcher", "a");
      sink.line("launcher", "b");
      const all = sink.entries();
      assert.equal(all.length, 2);
      const lastSeq = all[all.length - 1].seq;

      sink.line("launcher", "c");
      assert.equal(sink.tail(lastSeq).length, 1);
      assert.equal(sink.tail(lastSeq)[0].text, "c");

      const clearedSeq = sink.clearView();
      assert.ok(clearedSeq > lastSeq, "清屏必须推进水位");
      assert.equal(sink.tail(clearedSeq).length, 0);
      assert.equal(sink.entries().filter((e) => e.cleared).length, 1);

      // 环形缓冲上限生效
      sink.line("launcher", "d");
      sink.line("launcher", "e");
      assert.ok(sink.entries().length <= 3);
      sink.close();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("流式写入：stdout 与 stderr 各一个实例时行不粘", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-tray-stream-"));
  try {
    quiet(() => {
      const sink = createLineSink({ careerRoot: dir });
      const out = sink.stream("server");
      const err = sink.stream("server");
      out.write("out-1\nout-");
      err.write("err-1\nerr-2\n");
      out.write("2\n");
      const lines = sink.entries().map((entry) => entry.text);
      assert.deepEqual(lines, ["out-1", "err-1", "err-2", "out-2"]);
      sink.close();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
