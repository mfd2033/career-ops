// Qoder CN's argv + event parser (ADR-0052 决议 3-6, 12).
//
// The event lines below are hand-trimmed from a real 77-line capture of
// `qoderclicn v1.1.41` (one Bash-using task), not invented: Qoder emits lines
// the existing parser had never been shown (session hooks, thinking blocks,
// tool results, artifacts updates) and the parser file's own rule is that a
// shape nobody observed cannot be claimed. The capture stays out of the repo
// (it carries this machine's absolute paths and skill list); the SHAPES do not.
//
// Run:  node --test tests/lib/qoder-invocation.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_KINDS, argValue, toolNames, toolScopeFor } from "../../src/lib/claude-invocation.mjs";
import { QODER_EXTRA_DENIED, parseQoderEvent, qoderCliArgs, qoderPermissionFlags } from "../../src/lib/qoder-invocation.mjs";

const argv = qoderCliArgs({ kind: "evaluate", prompt: "PROMPT" });
const json = (o) => JSON.stringify(o);

// --- argv -------------------------------------------------------------------

test("the argv turns the structured stream on without the flag Qoder rejects", () => {
  assert.deepEqual(argv.slice(0, 4), ["-p", "--output-format", "stream-json", "--include-partial-messages"]);
  assert.ok(!argv.includes("--verbose"), "--verbose is rejected by qoderclicn (Claude requires it)");
  assert.equal(argv.at(-1), "PROMPT", "the prompt must stay last — -p takes no value");
});

test("the prompt is a positional, so a model flag can still be appended after it", () => {
  // withModelFlag appends `--model …` AFTER the prompt; measured to parse fine.
  assert.equal(argv.filter((a) => a === "PROMPT").length, 1);
  assert.ok(argv.indexOf("PROMPT") > argv.indexOf("--disallowed-tools"));
});

test("no kind may ask for a blanker permission mode than the audited one", () => {
  for (const kind of KNOWN_KINDS) {
    const args = qoderCliArgs({ kind, prompt: "p" });
    assert.equal(argValue(args, "--permission-mode"), "accept_edits", `${kind} must not change the mode`);
    for (const blanket of ["--dangerously-skip-permissions", "--yolo", "--always-approve", "--yes"]) {
      assert.ok(!args.includes(blanket), `${kind} must not carry ${blanket}`);
    }
  }
});

// --- the single source of truth for tool scope ------------------------------

test("every kind's allow list is the audited source, verbatim", () => {
  for (const kind of KNOWN_KINDS) {
    assert.equal(
      argValue(qoderPermissionFlags(kind), "--allowed-tools"),
      toolScopeFor(kind).allowed,
      `${kind}: the allow list must BE toolScopeFor(kind).allowed`,
    );
  }
});

test("read-only kinds ship the exact deny list this policy promises", () => {
  // A LITERAL, deliberately not recomputed from the same expression the
  // implementation uses: a derived expectation would keep passing while both
  // sides rotted together, which is the one failure a policy guard must not have.
  assert.equal(
    argValue(qoderPermissionFlags("pdf"), "--disallowed-tools"),
    "Write,Edit,MultiEdit,NotebookEdit,Bash,Task," +
      "Monitor,Agent,TaskCreate,TaskGet,TaskList,TaskStop,TaskUpdate," +
      "CronCreate,CronDelete,CronList,ScheduleWakeup,Workflow,EnterWorktree,ExitWorktree," +
      "ImageGen,CreateGoal,GetGoal,UpdateGoal",
  );
});

test("every kind's deny list is the audited source plus Qoder's own superset", () => {
  for (const kind of KNOWN_KINDS) {
    const expected = [...toolNames(toolScopeFor(kind).disallowed), ...QODER_EXTRA_DENIED].join(",");
    assert.equal(
      argValue(qoderPermissionFlags(kind), "--disallowed-tools"),
      expected,
      `${kind}: the deny list must equal toolScopeFor(kind).disallowed ∪ QODER_EXTRA_DENIED`,
    );
  }
});

test("a tool is never granted and denied at once", () => {
  for (const kind of KNOWN_KINDS) {
    const allowed = new Set(toolNames(toolScopeFor(kind).allowed));
    const overlap = QODER_EXTRA_DENIED.filter((t) => allowed.has(t));
    assert.deepEqual(overlap, [], `${kind}: granted and denied at once: ${overlap.join(", ")}`);
  }
});

test("the deny list covers the execution path the probe actually found", () => {
  // Measured: with Bash denied but Monitor allowed, the command still ran
  // (`echo PERM-OK` came back on stdout); with Monitor also denied, the CLI
  // reported it had no shell tool at all.
  assert.ok(QODER_EXTRA_DENIED.includes("Monitor"), "Monitor can execute commands — it must stay denied");
  const denied = new Set(toolNames(argValue(qoderPermissionFlags("pdf"), "--disallowed-tools")));
  assert.ok(denied.has("Monitor"), "the pdf kind must not keep an execution path open");
  assert.ok(denied.has("Bash") && denied.has("Write") && denied.has("Edit"), "pdf keeps its denials");
});

// --- event parsing ----------------------------------------------------------

test("parser: system/init becomes the ready status", () => {
  const line = json({ type: "system", subtype: "init", qodercli_version: "1.1.41", model: "auto", tools: ["Bash"] });
  assert.deepEqual(parseQoderEvent(line), { status: "Agent ready" });
});

test("parser: Qoder's own line shapes are dropped, not rendered", () => {
  // None of these exist in a Claude stream; all six appeared in the real capture.
  const noise = [
    { type: "system", subtype: "hook_started", hook_name: "Initializing Qoder Security", hook_event: "SessionStart" },
    { type: "system", subtype: "hook_progress", hook_name: "cmd.exe", hook_event: "SessionStart", stdout: "{}", stderr: "" },
    { type: "system", subtype: "hook_response", hook_name: "cmd.exe", hook_event: "SessionStart", exit_code: 0 },
    { type: "system", subtype: "artifacts_update", artifacts: [] },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "one-token answer" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call_1", content: "hi" }] } },
  ];
  for (const ev of noise) {
    assert.equal(parseQoderEvent(json(ev)), null, `must be dropped: ${ev.type}/${ev.subtype ?? ev.message.content[0].type}`);
  }
});

test("parser: a streamed tool start and the completed call both surface", () => {
  const start = json({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Bash" } } });
  assert.deepEqual(parseQoderEvent(start), { tool: "Bash" });

  const done = json({ type: "assistant", message: { content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "echo hello-from-qoder", description: "Print hello" } }] } });
  assert.deepEqual(parseQoderEvent(done), { tool: "Bash", detail: "echo hello-from-qoder" });
});

test("parser: a successful result reports NOTHING rather than zero usage", () => {
  // Qoder CN's own shape: every counter 0, and the credits it really burned are
  // not in this line at all. "0 tokens · $0.00" would be a false claim.
  const line = json({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: "DONE",
    total_cost_usd: 0,
    total_credits: 0,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  });
  assert.equal(parseQoderEvent(line), null);
});

test("parser: a failed result keeps its diagnostic while dropping the zeros", () => {
  const line = json({
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 1,
    result: "Not logged in · Please run /login",
    total_cost_usd: 0,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
  });
  assert.deepEqual(parseQoderEvent(line), { error: "Not logged in · Please run /login" });
});

test("parser: junk and non-JSON lines are ignored", () => {
  assert.equal(parseQoderEvent("not json"), null);
  assert.equal(parseQoderEvent(""), null);
  assert.equal(parseQoderEvent("null"), null);
});

// --- wiring -----------------------------------------------------------------
//
// clis.ts is TypeScript and this suite is .mjs, so the row is asserted as text
// (the repo's other clis.ts guards do the same). Without this, the engine could
// keep a plain-text argv and a dropped stderr classifier while every unit above
// still passes — the widget would simply never show a step.

const CLIS_TS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "lib", "clis.ts");
const clisSrc = readFileSync(CLIS_TS, "utf8");

test("the qoder-cn row is wired to this module's builder and parser", () => {
  const row = /id:\s*"qoder-cn"[^\n]*/.exec(clisSrc);
  assert.ok(row, "KNOWN has no qoder-cn row");
  assert.match(row[0], /streamArgsFor:\s*qoderCliArgs/, "the row must take its stream argv from qoderCliArgs");
  assert.match(row[0], /parseEvent:\s*parseQoderEvent/, "the row must parse with parseQoderEvent");
});

test("the qoder-cn row declares no stderr classifier", () => {
  // Measured: cwd in the repo root makes the CLI write "Skill conflict:" lines
  // to stderr on a run that succeeds, so the generic classifier must stay in
  // charge — it does not match those, and the real failure (not logged in)
  // arrives on the result event instead.
  const row = /id:\s*"qoder-cn"[^\n]*/.exec(clisSrc);
  assert.ok(row, "KNOWN has no qoder-cn row");
  assert.ok(!/stderrIsFatal/.test(row[0]), "Qoder must not get a stderr classifier");
});
