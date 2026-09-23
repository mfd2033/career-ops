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
  return { args, structured: typeof spec.parseEvent === "function" };
}
