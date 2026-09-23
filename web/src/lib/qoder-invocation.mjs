import { toolNames, toolScopeFor } from "./claude-invocation.mjs";
import { parseClaudeEvent } from "./run-cli-support.mjs";

// Qoder CN's headless argv and event parser (ADR-0052).
//
// This file exists instead of reusing `claude-invocation.mjs` + `parseClaudeEvent`
// wholesale for two separate reasons:
//
//   1. The ARGV differs in ways that matter. `-p` is a VALUELESS boolean (the
//      prompt is a positional argument), `--verbose` is rejected outright
//      (Claude's stream-json instead REQUIRES it), and the permission flags are
//      spelled `--allowed-tools` / `--disallowed-tools` with an underscore mode
//      value (`accept_edits`, which the CLI then echoes as `acceptEdits`). A
//      Claude argv cannot simply be handed over.
//   2. Qoder's tool set is a SUPERSET of Claude's (29 tools in `system/init`,
//      including ones Claude has no equivalent for). The policy below is the
//      same policy, applied to that superset — see QODER_EXTRA_DENIED.
//
// The EVENT STREAM, by contrast, is Claude's shape line for line: `system/init`,
// `assistant` (with `tool_use` blocks carrying full input), `stream_event`
// (content_block_start/delta/stop, message_delta, message_stop), `result`. All
// of it verified on a real 77-line capture, so `parseQoderEvent` delegates and
// overrides exactly one thing — the usage figure Qoder does not report.

/**
 * Qoder's OWN tools that can execute a command, touch the filesystem, fan out
 * sub-agents, or change the session's state — none of which Claude's audited
 * lists can mention, because Claude has no tools by these names.
 *
 * Why an explicit list rather than "the unknown ones stay unmentioned":
 * `claude-invocation.mjs` states the rule this file inherits — a tool that can
 * write or execute must be EXPLICITLY denied for every kind that does not need
 * it, because "unmentioned" is the one status such a tool must never have (the
 * permission mode auto-approves edits). Qoder makes that rule load-bearing
 * again, by adding names to the superset:
 *
 *   - `Monitor` — measured, not assumed: with `--disallowed-tools Bash` but
 *     Monitor allowed, a `echo …` prompt still ran the command and reported its
 *     stdout ({"tool_use: [Monitor, Read]"}); adding Monitor to the deny list
 *     made the same prompt answer "no shell execution tool is available"
 *     ({"tool_use": []}). So this is a real execution path, and denying it is
 *     what keeps the pdf/research kinds free of one (ADR-0052 决议 4 修正).
 *   - `EnterWorktree`/`ExitWorktree` create and remove a git worktree on disk;
 *     `CronCreate`/`ScheduleWakeup` persist scheduled work into the CLI's own
 *     state; `Agent`/`Task*` fan out sub-agents with unbounded cost (Claude's
 *     `Task` is denied for the same reason).
 *
 * Read-only queries among these (`TaskGet`, `CronList`, …) are denied too: the
 * list is "everything not audited", and denying a read costs nothing while a
 * missed write cannot be undone. Kept sorted-ish by role, frozen so a caller
 * cannot widen it by mutation.
 */
export const QODER_EXTRA_DENIED = Object.freeze([
  "Monitor",
  "Agent",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TaskUpdate",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "Workflow",
  "EnterWorktree",
  "ExitWorktree",
  "ImageGen",
  "CreateGoal",
  "GetGoal",
  "UpdateGoal",
]);

/**
 * The permission flags for a kind, WITHOUT the transport flags.
 *
 * The allow/deny SETS come from `claude-invocation.mjs`'s `toolScopeFor` — the
 * single audited source — and only the flag spelling changes (underscore mode
 * value, hyphenated tool flags). QODER_EXTRA_DENIED is then unioned into the
 * deny value, which is what applies this CLI's policy to Qoder's superset.
 *
 * Both values are comma-joined, matching Claude's argv: measured on Qoder CN
 * v1.1.41 that a comma-joined list is parsed as a list (allow AND deny), that
 * deny beats allow, and that a repeated-flag spelling works equally well — so
 * the shape that keeps the two engines comparable was chosen.
 *
 * @param {string} kind - Worker kind ("evaluate", "pdf", …).
 * @returns {string[]} [--permission-mode, --allowed-tools, --disallowed-tools] flags.
 */
export function qoderPermissionFlags(kind) {
  const scope = toolScopeFor(kind);
  const disallowed = [...new Set([...toolNames(scope.disallowed), ...QODER_EXTRA_DENIED])].join(",");
  return [
    "--permission-mode", "accept_edits",
    "--allowed-tools", scope.allowed,
    "--disallowed-tools", disallowed,
  ];
}

/**
 * The complete headless Qoder CN argv for a run.
 *
 * Assembled here rather than in the route, so a guard can assert on the command
 * line that actually ships (the same reason `claudeCliArgs` lives in a module).
 * The prompt is the LAST argument: `-p` takes no value, so the prompt is a
 * positional and trailing flags (`withModelFlag` appends `--model …` after it)
 * must not be mistaken for it — measured to parse position-independently.
 *
 * No `--strict-mcp-config`: decision 13 of the ADR keeps the CLI's own user
 * configuration in play, on purpose, so a run behaves the way the same command
 * typed in a terminal would.
 *
 * @param {{kind: string, prompt: string}} args
 * @returns {string[]}
 */
export function qoderCliArgs({ kind, prompt }) {
  return [
    "-p",
    "--output-format", "stream-json",
    "--include-partial-messages",
    ...qoderPermissionFlags(kind),
    prompt,
  ];
}

/**
 * Convert one Qoder CN `--output-format stream-json` line into the dashboard's
 * event shape. Every line goes to `parseClaudeEvent`; the ONE override is the
 * usage figure.
 *
 * Qoder CN does not report usage: the captured `result` lines carry
 * `usage` with every counter at 0 and `total_cost_usd: 0`, while the credits it
 * actually burns appear only per-turn (`stream_event.message_delta.usage.credits`,
 * e.g. 0.0563). Passing those zeros through would make the run readout say
 * "0 tokens · $0.00" — a claim that the run cost nothing, when it cost credits.
 * `run-cli-support.mjs` states the rule being followed here: "nothing to report
 * must not look like an event". So the fields are dropped, and a result line
 * that carried NOTHING else becomes null rather than an empty event.
 *
 * If Qoder ever starts reporting real usage, delete this override and wire the
 * engine back to `parseClaudeEvent` — the delegation below makes that a one-line
 * change on purpose.
 *
 * @param {string} line
 * @returns {import("./run-cli-support.mjs").ParsedEvent | null}
 */
export function parseQoderEvent(line) {
  const ev = parseClaudeEvent(line);
  if (!ev) return null;
  if (!("tokens" in ev) && !("costUsd" in ev)) return ev;
  const rest = { ...ev };
  delete rest.tokens;
  delete rest.costUsd;
  // A result that only carried usage (the normal, successful Qoder run) has
  // nothing left to say — emit no event rather than "0 tokens".
  return Object.keys(rest).length > 0 ? rest : null;
}
