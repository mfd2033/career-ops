"use strict";

// 统一日志管道（工单 03 / ADR-0066）—— 换的是窗口实现，对外契约一字不改：
//
//   1. 路径 <careerRoot>/.career-ops-web/launcher.log，目录不存在就建；建不了就降级为
//      「只在内存/窗口」，不许因此起不来。
//   2. 行格式 `[HH:MM:SS] [launcher|server] 文本\n`；服务的 stdout 与 stderr **各用一个**
//      行缓冲实例（跨块的行边界不能粘行、不能撕行）。
//   3. 壳启动即 O_TRUNC（每次启动从空文件开始，不是追加）。
//   4. 一条日志的写失败不能中断另一条通道（文件坏时窗口照滚）。
//
// 另外持有一份最近 2000 行的内存环形缓冲：日志窗口打开时先渲染这份（避免只看到文件
// 尾部而错过启动期），再按增量续读。Go 版窗口就是「实时累积进编辑框」，语义对齐。

const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");

const SOURCES = new Set(["launcher", "server"]);
const RING_SIZE = 2000;
const LOG_DIR = ".career-ops-web";
const LOG_FILE = "launcher.log";
// createWriteStream 的 open 是异步的：文件被占时只会变成一个 error 事件。
// 启动期抢不到（上一个实例还在拆句柄 / 杀毒在扫）不该让整场没有 launcher.log，退避重试几次。
const LOG_OPEN_RETRIES = 4;

// 打包后的 GUI 进程没有控制台：stdout 可能是个已关闭/无人读的管道。
// 先吞掉它的 error 事件，免得一个 EPIPE 把托盘带走（日志文件才是真相源）。
try {
  process.stdout?.on?.("error", () => {});
} catch {
  /* 没有 stdout 就什么都不用做 */
}

/** `[HH:MM:SS] [source] text\n` —— 纯函数，时钟由调用方传入，测试里可确定。 */
function formatLogLine(clock, source, text) {
  return `[${clock}] [${source}] ${text}\n`;
}

/** `Date` → `HH:MM:SS`（本地时钟，与旧 Go 的 15:04:05 对齐）。 */
function stamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 按 '\n' 切出已完成行（去掉行尾 '\r'），返回行数组与需继续缓冲的末尾残行。 */
function drainCompleteLines(buffer) {
  const lines = [];
  let rest = buffer;
  for (;;) {
    const index = rest.indexOf("\n");
    if (index < 0) return { lines, rest };
    lines.push(rest.slice(0, index).replace(/\r$/, ""));
    rest = rest.slice(index + 1);
  }
}

/**
 * 创建日志汇聚器。
 *
 * @param {{careerRoot: string, extraWriter?: object|null, ringSize?: number, now?: () => Date}} opts
 * @returns {{
 *   path: string, fileOk: boolean, line: (source: string, text: string) => void,
 *   stream: (source: string) => Writable, entries: () => object[], tail: (afterSeq: number) => object[],
 *   subscribe: (fn: (entry: object) => void) => () => void, clearView: () => void, close: () => void
 * }}
 */
function createLineSink({ careerRoot, extraWriter = null, ringSize = RING_SIZE, now = () => new Date() } = {}) {
  const logPath = path.join(careerRoot, LOG_DIR, LOG_FILE);
  const warned = new Set();
  let fileStream = null;

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    openLogFile();
  } catch {
    warnOnce("file", `日志文件打不开（降级为仅内存）：${logPath}`);
    fileStream = null;
  }

  function openLogFile(attempt = 0) {
    let stream;
    try {
      stream = fs.createWriteStream(logPath, { flags: "w" });
    } catch (error) {
      // 同步抛（路径非法等）重试也没意义
      warnOnce("file", `日志文件打不开（降级为仅内存）：${logPath}（${error.code || error.message}）`);
      fileStream = null;
      return;
    }
    fileStream = stream;
    stream.on("error", (error) => {
      if (fileStream !== stream) return;
      if (attempt < LOG_OPEN_RETRIES) {
        setTimeout(() => openLogFile(attempt + 1), 150 * (attempt + 1));
        return;
      }
      warnOnce("file", `日志文件写入失败（降级为仅内存）：${logPath}（${error.code || error.message}）`);
      fileStream = null;
    });
  }

  let seq = 0;
  const ring = [];
  const subscribers = new Set();

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      process.stderr.write(`[career-tray] ${message}\n`);
    } catch {
      /* stderr 也可能不可用（GUI 子系统）：告警本身不值得再抛 */
    }
  }

  function writeQuietly(target, text, key) {
    if (!target || target.destroyed || target.writable === false) return;
    try {
      target.write(text);
    } catch {
      warnOnce(key, `日志通道 ${key} 写入失败（其余通道继续）`);
    }
  }

  /** 写入一整行：环形缓冲 + 控制台 + 额外目的地 + 文件，任一失败不阻断其余。 */
  function line(source, text) {
    const clock = stamp(now());
    const entry = { seq: (seq += 1), t: clock, source: SOURCES.has(source) ? source : "launcher", text };
    ring.push(entry);
    if (ring.length > ringSize) ring.shift();

    const formatted = formatLogLine(clock, entry.source, text);
    writeQuietly(process.stdout, formatted, "stdout");
    writeQuietly(extraWriter, formatted, "extra");
    writeQuietly(fileStream, formatted, "file");

    for (const fn of subscribers) {
      try {
        fn(entry);
      } catch {
        /* 订阅者自己的异常不能带走日志主流程 */
      }
    }
  }

  /** 每条流一个实例：各自持有残行缓冲，故两条流交错时不会粘行/撕行。 */
  function stream(source) {
    let partial = "";
    return new Writable({
      write(chunk, _encoding, callback) {
        partial += chunk.toString("utf8");
        const { lines, rest } = drainCompleteLines(partial);
        partial = rest;
        for (const text of lines) line(source, text);
        callback();
      },
      final(callback) {
        if (partial.length > 0) line(source, partial);
        partial = "";
        callback();
      },
    });
  }

  return {
    path: logPath,
    get fileOk() {
      return fileStream !== null;
    },
    line,
    stream,
    entries: () => ring.slice(),
    tail: (afterSeq) => ring.filter((entry) => entry.seq > afterSeq),
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    /**
     * 日志窗口的「清屏」：只清视图（seq 水位），不碰文件。
     * 返回新的水位，渲染层从它之后继续 tail。
     */
    clearView: () => {
      seq += 1;
      ring.push({ seq, t: stamp(now()), source: "launcher", text: "", cleared: true });
      if (ring.length > ringSize) ring.shift();
      return seq;
    },
    close() {
      subscribers.clear();
      if (fileStream) {
        try {
          fileStream.end();
        } catch {
          /* 关不上也不影响退出 */
        }
        fileStream = null;
      }
    },
  };
}

module.exports = { LOG_DIR, LOG_FILE, RING_SIZE, createLineSink, drainCompleteLines, formatLogLine, stamp };
