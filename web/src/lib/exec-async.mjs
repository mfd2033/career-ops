import { execFile } from "node:child_process";
import { promisify } from "node:util";

// exec-async.mjs — 请求路径上唯一的「跑一个子进程并拿 stdout」入口（ADR-0098 决议 3）。
//
// WHY: web 是单进程单事件循环。`execSync`/`spawnSync`/`execFileSync` 会把整个服务
// 冻到子进程退出为止——`/api/clis` 的「重新检测」实测 4.8s（模型目录冷时 17.8s），
// 期间托盘 2.5s 的探针和扩展 6s 的探测全部超时，于是「服务活着」被两边同时读成
// 「服务异常」。改成异步之后，探测之间还能并发跑（`Promise.all`），总时长从「求和」
// 变成「最慢的那一个」。
//
// 语义与 execFileSync 对齐的三件事，别改：
//   • 超时 → 子进程被 kill，Promise 以错误拒绝（调用方按失败降级）；
//   • 非零退出 → 拒绝（`error.code` 是退出码）；
//   • stderr 只用于诊断，不往外抬（stdout 才是契约）。
// `stdio` 故意不传：execFile 需要管道才能把 stdout 还给我们。

const execFileAsync = promisify(execFile);

/** 默认 stdout 上限：`--version`/模型目录这类输出都在几 KB，4MB 只是防跑飞。 */
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * 跑一个子进程，返回它的 stdout（字符串）。
 *
 * @param {string} file 可执行文件（按 PATH 解析，或用绝对路径）
 * @param {string[]} args 参数
 * @param {{timeoutMs?: number, env?: NodeJS.ProcessEnv, cwd?: string}} [options]
 * @returns {Promise<string>} stdout；失败抛错（含超时与非零退出）
 */
export async function stdoutOf(file, args, { timeoutMs = 15_000, env, cwd } = {}) {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: DEFAULT_MAX_BUFFER,
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
  });
  return stdout;
}
