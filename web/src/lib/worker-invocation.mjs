// web/src/lib/worker-invocation.mjs — ADR-0054: headless worker argv 的唯一选择器。
//
// /api/run（单任务）与 /api/batch-evaluate（批量）都必须从这里取 worker argv，
// 路由自身不得 import 任何引擎专属 builder（claudeCliArgs / codexStreamArgs /
// qoderCliArgs / codebuddyCliArgs）——「同一策略写两份，其中一份漂了」正是
// 2026-09-15 权限 bug 的结构性教训，守卫见 tests/lib/batch-stream-events.test.mjs。
//
// 能力声明住在 CliSpec 上（clis.ts）：
//   • streamArgsFor({kind, prompt}) — argv 随 run kind 变化的引擎（claude /
//     qoder-cn / codebuddy），per-kind 权限 flag 由各引擎自己的 builder 给出，
//     那是唯一经过审计的权限模型；
//   • streamArgs(prompt)           — 固定结构化 argv（codex --json）；
//   • args(prompt)                 — 纯文本 argv，信封解析类调用方依赖它，必须
//     保持无结构。
// structured = parseEvent 存在：仅此时调用方对 stdout 做 JSONL 缓冲并喂
// spec.parseEvent；否则按原始文本 + regex 嗅探处理。

/**
 * worker 派发时必须追加的「故障可见性」flag，按引擎 id 索引。
 *
 * 这里只放 worker 路径——它们才有 ADR-0094 的致命行判定链（classifyFatalStderr →
 * terminateCli）。放进 CliSpec.args 会连带污染 assistant / cv-ingest / explore /
 * apply 这些把 stderr 直接转给用户的路由，多出一堆 `level=ERROR` 原文。
 *
 * opencode 的起因（2026-11-09 实测）：额度耗尽时它把
 *   `stream error … AI_APICallError: Free usage limit reached …`
 * 只写进自己的日志文件 `~/.local/share/opencode/log/opencode.log`，子进程的
 * stdout/stderr 只有一行 banner，进程还不退出。判定链再准也没有原料可判，单任务 run
 * 只能等满 30 分钟总阀（21:23 派发，21:53 才被杀，26 分钟零输出、零 token）。
 * `--print-logs --log-level ERROR` 是 opencode 自己 `run --help` 里的 flag，实测把同一条
 * 错误在 7 秒内镜像到 stderr，于是既有的分类器立刻停机。
 */
const ENGINE_LOG_MIRROR_ARGS = {
  opencode: ["--print-logs", "--log-level", "ERROR"],
};

/**
 * Pick the argv for a headless worker, and say whether its stdout is structured.
 *
 * Selection order mirrors /api/run verbatim (streamArgsFor > streamArgs > args),
 * so the two routes can never drift apart on how a worker is invoked.
 *
 * @param {import("./clis.ts").CliSpec} spec
 * @param {{ kind: string; prompt: string }} run
 * @returns {{ args: string[]; structured: boolean }}
 */
export function resolveWorkerInvocation(spec, { kind, prompt }) {
  const args = spec.streamArgsFor
    ? spec.streamArgsFor({ kind, prompt })
    : (spec.streamArgs ?? spec.args)(prompt);
  // 追加在末尾：各引擎的 flag 解析器都允许 positional 之后跟 flag（run 路由本来
  // 就靠这一点追加 --title / --model），因此不改变任何既有 argv 的语义。
  const mirror = ENGINE_LOG_MIRROR_ARGS[spec.id] ?? [];
  return { args: mirror.length > 0 ? [...args, ...mirror] : args, structured: typeof spec.parseEvent === "function" };
}
