import { toolNames, toolScopeFor } from "./claude-invocation.mjs";
import { parseClaudeEvent } from "./run-cli-support.mjs";

// CodeBuddy Code's headless argv and event parser (ADR-0053).
//
// This file exists instead of reusing `claude-invocation.mjs` + `parseClaudeEvent`
// wholesale for two separate reasons:
//
//   1. The PERMISSION TRANSPORT differs, and the difference was measured rather
//      than assumed. The flag spelling Claude uses is not reliable here:
//
//        --allowedTools "Read,Bash"          → Bash DENIED (allow did not apply)
//        --allowedTools "Bash(echo:*)"       → worked (a single specifier)
//        --disallowedTools "Bash,PowerShell,…"
//                                            → Bash denied, but PowerShell RAN
//                                              (an explicit deny, silently ignored)
//        --settings {permissions:{allow}}    → worked
//        --settings {permissions:{deny}}     → tools REMOVED from the toolset
//
//      So the policy travels as `--settings` JSON. Note also what the same runs
//      showed about `allow`: it is NOT a whitelist. With `allow:["Read"]` and no
//      mention of `PowerShell`, the model called PowerShell and it executed. The
//      only real gate is the DENY list, which is why CODEBUDDY_EXTRA_DENIED has
//      to be complete rather than "the obvious ones" — same lesson as Qoder's
//      `Monitor` (ADR-0052 决议 4), one tool further along.
//   2. CodeBuddy's tool set is a SUPERSET of Claude's (34 tools in `system/init`).
//      The policy is the same policy, applied to that superset.
//
// The EVENT STREAM, by contrast, is Claude's shape line for line: `system/init`,
// `assistant` (tool_use blocks carrying full input), `stream_event`
// (content_block_start/delta/stop, message_delta, message_stop), `user`
// (`tool_result`), `result`. Verified on four real captures (22/129/8/8 lines) —
// `parseClaudeEvent` parsed every line without a single exception, so
// `parseCodebuddyEvent` delegates and overrides exactly one field.

/**
 * CodeBuddy's OWN tools that can execute a command, touch the filesystem, fan out
 * sub-agents, act on external channels, or change session state — none of which
 * Claude's audited lists can mention, because Claude has no tools by these names.
 *
 * `PowerShell` is the one that matters most, and it is measured, not assumed:
 * with `--settings {permissions:{allow:["Read"],deny:["Bash",…]}}` (no
 * `PowerShell` in the deny list, because at that point we did not know it
 * existed) the model called `PowerShell {command:"echo hi"}` and the command ran.
 * Adding it to the deny list made the same prompt answer "I don't have a
 * shell/PowerShell tool available in this context" with ZERO tool calls. A
 * Windows tool set ships a second shell; the deny list is where that gets said.
 *
 * Read-only entries (`TaskGet`, `TaskOutput`, `ListMcpResources`, …) are denied
 * too: the list is "everything not audited", denying a read costs nothing, and a
 * missed write cannot be undone. Sorted-ish by role, frozen so a caller cannot
 * widen it by mutation.
 */
export const CODEBUDDY_EXTRA_DENIED = Object.freeze([
  "PowerShell",
  "Agent",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "TaskStop",
  "TaskOutput",
  "TeamCreate",
  "TeamDelete",
  "SendMessage",
  "Skill",
  "ToolSearch",
  "DeferExecuteTool",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "StructuredOutput",
  "ImageGen",
  "VideoGen",
  "WeChatReply",
  "WeComReply",
  "MessageColleague",
  "SpeakInChannel",
  "ListMcpResources",
  "ReadMcpResource",
]);

/**
 * The permission flags for a kind, WITHOUT the transport flags.
 *
 * The allow/deny SETS come from `claude-invocation.mjs`'s `toolScopeFor` — the
 * single audited source — and only their transport changes: one `--settings`
 * JSON object instead of two comma-joined flag values, because on this CLI the
 * flag values were measured to fail in both directions (see the header).
 *
 * `--permission-mode acceptEdits` rides along because the settings allow list is
 * an auto-approve list, not a whitelist: without a mode that lets the granted
 * edit tools proceed, the persisting kinds would stall on an approval prompt
 * that a non-interactive run cannot show.
 *
 * @param {string} kind - Worker kind ("evaluate", "pdf", …).
 * @returns {string[]} [--permission-mode, --settings] flags.
 */
export function codebuddyPermissionFlags(kind) {
  const scope = toolScopeFor(kind);
  const deny = [...new Set([...toolNames(scope.disallowed), ...CODEBUDDY_EXTRA_DENIED])];
  const settings = { permissions: { allow: toolNames(scope.allowed), deny } };
  return ["--permission-mode", "acceptEdits", "--settings", JSON.stringify(settings)];
}

/**
 * The complete headless CodeBuddy argv for a run.
 *
 * Assembled here rather than in the route, so a guard can assert on the command
 * line that actually ships (the same reason `claudeCliArgs` lives in a module).
 *
 * The prompt sits IMMEDIATELY after `-p`, deliberately: a bare `--allowedTools`
 * (which this engine spells as a variadic `<tools...>`) swallows a positional
 * argument that follows it, and a run that loses its prompt degrades silently —
 * measured, the CLI then emits two lines with `model: "unknown"` and an empty
 * `result` and still exits 0. Trailing flags (`withModelFlag` appends
 * `--model …`) were measured to parse position-independently.
 *
 * @param {{kind: string, prompt: string}} args
 * @returns {string[]}
 */
export function codebuddyCliArgs({ kind, prompt }) {
  return [
    "-p", prompt,
    "--output-format", "stream-json",
    "--include-partial-messages",
    ...codebuddyPermissionFlags(kind),
  ];
}

/**
 * Convert one CodeBuddy `--output-format stream-json` line into the dashboard's
 * event shape. Every line goes to `parseClaudeEvent`; the ONE override is the
 * cost figure.
 *
 * CodeBuddy reports REAL token usage (`result.usage` carried 49611 / 76732 /
 * 76229 / 76603 across four captures, and `modelUsage` names the model), so
 * unlike Qoder — whose counters are all zero (ADR-0052 决议 6) — the tokens are
 * kept. Its `total_cost_usd` is always 0, though, and a run readout of "$0.00"
 * claims the run was free. Only that field is dropped, and a result line that
 * carried nothing else becomes null rather than an empty event.
 *
 * `system/status` and `file-history-snapshot` (CodeBuddy-only line types) are
 * dropped by `parseClaudeEvent`'s default, which is the behaviour we want: they
 * carry no step for the user to see.
 *
 * If CodeBuddy ever starts reporting a real cost, delete this override and wire
 * the engine back to `parseClaudeEvent` — the delegation makes that a one-line
 * change on purpose.
 *
 * @param {string} line
 * @returns {import("./run-cli-support.mjs").ParsedEvent | null}
 */
export function parseCodebuddyEvent(line) {
  const ev = parseClaudeEvent(line);
  if (!ev) return null;
  if (!("costUsd" in ev)) return ev;
  const rest = { ...ev };
  delete rest.costUsd;
  return Object.keys(rest).length > 0 ? rest : null;
}
