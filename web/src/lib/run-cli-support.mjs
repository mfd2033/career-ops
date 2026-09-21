// Plain .mjs (same pattern as tracker-table.mjs/clean-chips.mjs/spawn-cli.mjs)
// so tests/lib/run-cli-support.test.mjs can import it directly under Node. Import it
// with the .mjs extension included (e.g. "@/lib/run-cli-support.mjs" or
// "./run-cli-support.mjs") — unlike .ts files, which TypeScript resolves
// without an extension, ESM specifiers for plain JS modules must be fully
// specified.
import { isReservedReportFile } from "./report-files.mjs";
import { statSync } from "node:fs";
import path from "node:path";

/**
 * Dashboard-friendly shape both `parseCodexEvent` and `parseClaudeEvent` return.
 * Usually at most one payload field (`tool`/`text`/`tokens`/`costUsd`/`error`) is
 * set per event; `status` may accompany any of them, and `tokens`/`costUsd` may
 * co-occur on a Claude `result` event.
 * `costUsd` is `number | null`: null is a REPORTED absence, not a missing field —
 * Codex sends usage with no cost, and callers must not fill that in with a rate.
 * `detail` (ADR-0042 决议 2) carries a tool call's primary-parameter summary —
 * verbatim forwarding of what the agent actually invoked, never a business-phase
 * interpretation. Claude's `assistant` event carries the completed tool_use
 * block (the partial `content_block_start` has an empty input), so only that
 * path can supply one.
 * @typedef {{status?: string, tool?: string, detail?: string, text?: string, tokens?: number, costUsd?: number | null, error?: string}} ParsedEvent
 */

/**
 * Pick the one parameter that says what a tool call is doing, verbatim.
 *
 * ADR-0042 决议 2 的「原始透传」：只摘参数、不翻译、不推断业务语义 ——
 * 「WebFetch: https://…」就是全部，绝不写成「正在体检因子3」。每类工具取其
 * 主参数（Unknown 输入返回 null，调用方就不加摘要）；截断到 120 字符防长
 * payload 进 UI 与 localStorage。非字符串值（数字、对象）一律跳过——摘要
 * 只服务人眼，宁缺毋假。
 *
 * @param {string} name - Tool name ("WebFetch", "Bash", …).
 * @param {unknown} input - The completed tool_use block's input object.
 * @returns {string|null} Primary-parameter summary, or null when nothing safe to show.
 */
export function summarizeToolInput(name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const PRIMARY_KEYS = {
    WebFetch: "url",
    WebSearch: "query",
    Bash: "command",
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    NotebookEdit: "notebook_path",
    Glob: "pattern",
    Grep: "pattern",
    TodoWrite: null,
    Task: null,
  };
  const key = Object.prototype.hasOwnProperty.call(PRIMARY_KEYS, name) ? PRIMARY_KEYS[name] : null;
  if (!key) return null;
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

const STATUS_READY = "Agent ready";
const STATUS_RECONNECTING = "Reconnecting…";

/**
 * Token accounting across CLIs — the two conventions are OPPOSITE, and the
 * formula is the only place that difference is visible (adapted from #2689,
 * which reached this from the accounting side).
 *
 * The dashboard's metric is TOKENS BILLED AT FULL RATE — `/api/usage/route.ts`
 * defines it as input + output + cache-creation, deliberately omitting
 * discounted cache reads.
 *
 *   Claude  `input_tokens` EXCLUDES cache reads (they live in
 *           `cache_read_input_tokens`), and cache writes are a separate pool
 *           billed at full rate. → input + output + cache_creation
 *   Codex   `input_tokens` INCLUDES `cached_input_tokens` (OpenAI's
 *           convention), so adding is double-counting and the cached portion
 *           must be SUBTRACTED. → (input − cached) + output
 *
 * Getting this wrong throws nothing and reddens no test — it silently inflates
 * one runtime against another (~4.7× on a real run) in the very comparison
 * people use to control cost.
 */

/**
 * Append a selected model to a CLI argv, uniformly, for every runtime.
 *
 * The config page's model picker must reach the spawned process for ALL CLIs, but
 * each argv is built differently (claudeCliArgs, spec.streamArgs, spec.args, or an
 * inline array per route). One pure helper keeps the injection identical everywhere
 * and testable. The flag is appended AFTER the prompt so positional args (e.g. the
 * codex stream argv's trailing prompt) stay put — every supported CLI parses flags
 * position-independently.
 *
 * @param {string[]} args - the argv before model injection
 * @param {{flag?: string} | undefined | null} meta - the CLI's model metadata (may lack a flag)
 * @param {string | undefined | null} model - the user's selected model, or none
 * @returns {string[]} a NEW array; the caller's array is never mutated
 */
export function withModelFlag(args, meta, model) {
  if (!model || !meta?.flag) return args;
  return [...args, meta.flag, model];
}

/**
 * A usage figure, or 0 — guards nulls and junk in a partial usage block.
 *
 * `isSafeInteger`, not `isFinite`: a token count is a whole number, so a
 * fractional value from a malformed event is junk and must not reach the total
 * (CodeRabbit's finding on #2689's `n`, whose shape this shares).
 */
function tokenCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Auth failures, in wording shared across agent CLIs. Deliberately narrow: a
 * structured-output CLI's own event stream + exit code are authoritative for
 * everything else, so a stderr classifier only needs to catch the failures that
 * produce no usable stream at all. */
const FATAL_AUTH_STDERR_RE =
  /unauthorized|forbidden|not authenticated|please log in|sign[ -]?in required|credential.*missing/i;

/** Quota/rate-limit failures — fatal like auth, EXCEPT when the line announces
 * its own retry: the CLI is handling it, and the run can still complete
 * cleanly. Same reasoning as CODEX_TRANSIENT_ERROR_RE, for the stderr channel —
 * flagging a self-retrying 429 fatal re-creates the false-red #2085 exists to
 * remove (sawError fails the honesty gate even on exit 0 with a written
 * report). Auth gets no such carve-out: it never heals by retrying. */
const FATAL_QUOTA_STDERR_RE = /quota|rate limit/i;
// Only a retry the CLI ANNOUNCES AS IN PROGRESS ("retrying", "retry in 5s",
// "will retry") — a bare /retry/ would also match terminal wording like
// "do not retry" or "retry limit exhausted" and silence a genuine failure.
const RETRYING_STDERR_RE = /retrying|retry\s+in\b|will\s+retry/i;
const isFatalQuotaStderr = (line) => FATAL_QUOTA_STDERR_RE.test(line) && !RETRYING_STDERR_RE.test(line);

/** Claude Code's own wording for the same class of failure. */
const CLAUDE_FATAL_STDERR_RE = /invalid api key|please run \/login|credit balance|usage limit reached/i;

/** Codex `error` events that it recovers from on its own (see parseCodexEvent). */
const CODEX_TRANSIENT_ERROR_RE = /reconnect/i;

/**
 * Whether one Codex stderr chunk should be treated as a fatal error.
 *
 * Codex can emit benign ERROR-level diagnostics (e.g. a stale local model-cache
 * schema) and still complete successfully, so anything outside the auth/quota
 * set is left to its JSONL stream and exit code — and even a quota/rate-limit
 * line is non-fatal while it says the CLI is retrying.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isFatalCodexStderr(line) {
  return FATAL_AUTH_STDERR_RE.test(line) || isFatalQuotaStderr(line);
}

/**
 * Whether one Claude Code stderr chunk should be treated as a fatal error.
 *
 * Same reasoning as `isFatalCodexStderr`: Claude also has a structured stream
 * and a meaningful exit code, so the generic "contains the word error" fallback
 * would fail runs that actually succeeded — and a self-retrying rate limit gets
 * the same transient carve-out. Claude's own wording (invalid key, /login,
 * credit/usage limits) is always hard: none of those heal by retrying.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isFatalClaudeStderr(line) {
  return FATAL_AUTH_STDERR_RE.test(line) || CLAUDE_FATAL_STDERR_RE.test(line) || isFatalQuotaStderr(line);
}

/**
 * Whether one OpenCode stderr line should be treated as a fatal error.
 *
 * OpenCode, like Claude/Codex, streams its own progress/telemetry to stderr
 * (banner, model line, ANSI escapes, and — during an evaluation — the MCP
 * surface's stdout/stderr pass-through). A bare `\berror\b` / `not found` in
 * any of that is routine noise, so the generic fallback flagged clean runs as
 * "hit an error before finishing" even though the report and tracker row were
 * both written. OpenCode has a meaningful exit code (0 = clean, observed), so
 * apply the same classifier as Codex: only real auth and quota failures are
 * fatal on the stderr channel.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isFatalOpenCodeStderr(line) {
  return FATAL_AUTH_STDERR_RE.test(line) || isFatalQuotaStderr(line);
}

/**
 * Fallback classifier for a CLI with no `stderrIsFatal` of its own.
 *
 * Only claude and codex define one, so SIX of the eight entries in KNOWN reach
 * this path — including every runtime people pick to spend less than they would
 * on those two.
 *
 * The terms are ANCHORED. Unanchored, `auth` matched inside ordinary words and a
 * successful run got reported as failed because a word appeared:
 *
 *   "Authentication successful"   → fatal    ← a SUCCESS message
 *   "warning: no author found"    → fatal    ← "auth" inside "author"
 *   "fetching author metadata"    → fatal
 *   "Errors: 0"                   → fatal
 *
 * That is the same failure #2085 exists to remove, on the path #2102 left
 * untouched. Found by @gregaro in #1974.
 *
 * Anchoring, NOT narrowing: `not authenticated` and `authentication failed`
 * still match, and the multi-word phrases keep no `\b` because they cannot
 * collide with prose. Lives here rather than inline in route.ts so it can be
 * tested — the reason the drift went unnoticed is that a regex in a .ts closure
 * had no reachable test.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isFatalGenericStderr(line) {
  return GENERIC_FATAL_STDERR_RE.test(line);
}

const GENERIC_FATAL_STDERR_RE =
  /\berror\b|\bdenied\b|\bfatal\b|not found|\bunauthorized\b|\bforbidden\b|not authenticated|authentication failed|\blogin\b|log in|\bcredentials?\b|api[ -]?key|\bquota\b|rate limit/i;

/**
 * Parse `reserve-report-num.mjs` stdout into the reserved number list.
 *
 * Lives here rather than inline in batch-evaluate/route.ts so it can be tested
 * (tests/reservation-output-parse.test.mjs) — the inline `^(\d{3})...` version
 * hard-coded three-digit report numbers, so the moment reports crossed #999
 * every batch run died at the reserve step with "unexpected reservation
 * output: 1838-1851" (2026-09-15: 40 red cards per click, 854 leaked
 * RESERVED sentinels). `formatReportNumber` pads to three digits but never
 * truncates, and the allocator's own occupancy scan is `\d+`-wide, so the
 * lower bound here must be 3+ digits, not exactly 3.
 *
 * @param {string} stdout
 * @returns {number[]|null} Contiguous reserved numbers, or null on garbage.
 */
export function parseReservationOutput(stdout) {
  const m = stdout.trim().match(/^(\d{3,})(?:-(\d{3,}))?$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  return Array.from({ length: b - a + 1 }, (_, k) => a + k);
}

/**
 * The argv that makes `codex exec` emit the JSONL `parseCodexEvent` reads.
 *
 * Lives beside that parser rather than inline in clis.ts because the two are one
 * contract: `--json` is what produces the events, and `--color never` keeps ANSI
 * escapes out of the JSON strings. A caller that wants plain text must use
 * `CliSpec.args` instead — every non-dashboard surface reads codex's stdout
 * directly (`<<offer:>>`/`<<cv:>>` envelopes, the apply planners' JSON array).
 *
 * @param {string} prompt
 * @returns {string[]}
 */
export function codexStreamArgs(prompt) {
  return ["exec", "--json", "--color", "never", prompt];
}

/**
 * Convert one `codex exec --json` JSONL event into dashboard-friendly data.
 * @param {string} line
 * @returns {ParsedEvent | null}
 */
export function parseCodexEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  // JSON.parse("null") SUCCEEDS and yields null, and a bare scalar line yields a
  // number or string — none of which the try above rejects, so reading `.type`
  // off them throws past this function into the stdout handler. A parser written
  // to survive hostile input has to survive its own success cases too.
  if (!event || typeof event !== "object") return null;

  if (event.type === "thread.started") return { status: STATUS_READY };
  // Kind-agnostic on purpose: this parser serves every run kind (evaluate, pdf,
  // research, fix-portal), so the status must not claim one of them.
  if (event.type === "turn.started") return { status: "Agent working" };

  if (event.type === "item.started") {
    const type = event.item?.type;
    if (type === "command_execution") return { tool: "Bash" };
    if (type === "web_search") return { tool: "WebSearch" };
    if (type === "mcp_tool_call") return { tool: event.item?.tool || "Working" };
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    // Empty text carries nothing: emitting it would put a blank line in the run
    // log and an extra newline inside pdf mode's line-anchored envelope stream.
    if (typeof event.item.text !== "string" || event.item.text === "") return null;
    // Newline-terminate each message: Codex sends complete messages with NO
    // trailing newline ("hello", not "hello\n"), so consecutive messages would
    // otherwise concatenate mid-line downstream. That glued narration into one
    // run-on log line AND broke pdf mode outright — the <<cv-html>> markers are
    // line-anchored by design (cv-envelope.mjs, fail-closed), so an envelope
    // message following unterminated narration parsed as "no envelope" and the
    // honesty gate failed a run whose CV was fully emitted.
    const text = event.item.text;
    return { text: text.endsWith("\n") ? text : text + "\n" };
  }

  if (event.type === "turn.completed") {
    // No `usage` block means nothing to report — return null rather than a
    // {tokens: 0}, so the caller's `typeof === "number"` guard skips it instead
    // of clobbering a correct running total from an earlier turn.
    if (!event.usage) return null;
    const usage = event.usage;
    // Subtraction, not addition: see the header note on the two conventions.
    // Clamped at 0 so a malformed usage block can never report negative tokens.
    const fresh = Math.max(0, tokenCount(usage.input_tokens) - tokenCount(usage.cached_input_tokens));
    // costUsd stays null rather than being invented from a token count and a
    // guessed rate — Codex reports no cost, and a fabricated one reads as real.
    return { tokens: fresh + tokenCount(usage.output_tokens), costUsd: null };
  }

  if (event.type === "turn.failed" || event.type === "error") {
    const message = String(event.error?.message || event.message || "Codex failed before finishing");
    // `turn.failed` is terminal by definition, but a bare `error` event also
    // carries transient conditions Codex recovers from — a "Reconnecting..."
    // notice mid-run would otherwise flag the whole run as failed even though
    // the turn goes on to complete. Report it as progress, not as an error.
    if (event.type === "error" && CODEX_TRANSIENT_ERROR_RE.test(message)) return { status: STATUS_RECONNECTING };
    return { error: message };
  }

  return null;
}

/**
 * Convert one Claude Code `--output-format stream-json` line into the same
 * dashboard-friendly shape `parseCodexEvent` produces.
 * @param {string} line
 * @returns {ParsedEvent | null}
 */
export function parseClaudeEvent(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  // Same reason as parseCodexEvent's guard: JSON.parse("null") succeeds.
  if (!ev || typeof ev !== "object") return null;

  if (ev.type === "stream_event") {
    const e = ev.event;
    if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
      return { tool: e.content_block.name };
    }
    if (e?.type === "content_block_delta" && e.delta?.text) {
      return { text: e.delta.text };
    }
    return null;
  }

  if (ev.type === "system" && ev.subtype === "init") {
    return { status: STATUS_READY };
  }

  // The completed assistant message carries the tool_use block with its FULL
  // input — the `stream_event` content_block_start this file already parsed
  // starts with an empty input (the arguments arrive as later deltas), so only
  // here can the verbatim parameter summary ride along (ADR-0042 决议 2). The
  // route sends this as a second tool event; the client merges it into the
  // step it already created from the start event instead of adding a line.
  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    const block = ev.message.content.find((b) => b?.type === "tool_use" && typeof b.name === "string");
    if (block) {
      const detail = summarizeToolInput(block.name, block.input);
      return detail ? { tool: block.name, detail } : { tool: block.name };
    }
    return null;
  }

  if (ev.type === "result") {
    // Usage first, so a FAILED result still reports what it burned — the tokens
    // were spent either way, and dropping them undercounts exactly the runs a
    // user most wants to see the cost of.
    const result = {};
    if (ev.usage) {
      // Addition here, subtraction for Codex — see the header note. Claude's
      // input_tokens excludes cache reads, so cache writes must be added back
      // in; this is the same formula /api/usage uses.
      const u = ev.usage;
      result.tokens = tokenCount(u.input_tokens) + tokenCount(u.output_tokens) + tokenCount(u.cache_creation_input_tokens);
      if (typeof ev.total_cost_usd === "number") result.costUsd = ev.total_cost_usd;
    }
    // A terminal failure, the counterpart of parseCodexEvent's turn.failed. The
    // route's gate would otherwise have to infer this from the exit code alone,
    // and a non-zero exit is not guaranteed — a run that failed while exiting 0
    // would be banked as a confident score, the dishonest-success case this
    // whole file exists to prevent. `is_error` is the authoritative flag;
    // subtype is checked by PREFIX because the real values are
    // `error_max_turns` / `error_during_execution`, never a bare "error".
    if (ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype.startsWith("error"))) {
      // `result` carries the final text and is empty on failure, so it is only a
      // fallback; the subtype names the failure when no diagnostic is supplied.
      const diagnostic =
        (typeof ev.error === "string" && ev.error) ||
        (typeof ev.result === "string" && ev.result) ||
        (typeof ev.subtype === "string" && ev.subtype) ||
        "Claude failed before finishing";
      result.error = String(diagnostic);
    }
    // Null over an empty object: nothing to report must not look like an event.
    return Object.keys(result).length > 0 ? result : null;
  }

  return null;
}

/**
 * Fold one parsed event's token count into a running total. `turn.completed`
 * (Codex) and `result` (Claude) usage is per-event, not cumulative-since-start,
 * so callers must accumulate across multiple events in one run rather than
 * overwrite — otherwise a multi-turn run silently undercounts.
 *
 * @param {number} current
 * @param {ParsedEvent | null | undefined} ev
 * @returns {number}
 */
export function accumulateTokens(current, ev) {
  return typeof ev?.tokens === "number" ? current + ev.tokens : current;
}

/**
 * Completed report filenames from a raw `reports/` listing.
 * Reservation sentinels are not completed reports — `isReservedReportFile` is
 * the single definition of that convention, shared with career-ops.ts.
 *
 * @param {string[]} entries
 * @returns {Set<string>}
 */
export function completedReportNames(entries) {
  return new Set(entries.filter((name) => name.endsWith(".md") && !isReservedReportFile(name)));
}

/**
 * Whether `afterEntries` contains a completed report name absent from
 * `beforeEntries` — i.e. persistence actually happened, as opposed to a
 * `NNN-RESERVED.md` sentinel merely being replaced or churned.
 * @param {string[]} beforeEntries
 * @param {string[]} afterEntries
 * @returns {boolean}
 */
export function hasNewCompletedReport(beforeEntries, afterEntries) {
  const before = completedReportNames(beforeEntries);
  const after = completedReportNames(afterEntries);
  for (const name of after) {
    if (!before.has(name)) return true;
  }
  return false;
}

/**
 * Worker kinds whose honesty gate demands a persisted artifact.
 *
 * checkup joined evaluate here after 2026-09-16: two checkup workers were
 * aborted by their upstream relay mid-research ("任务处理步骤过多已自动中止"),
 * the CLI exited 0 with an apology as its final message, and the route — whose
 * artifact check was inline and evaluate-only — banked both zero-artifact runs
 * as `done` (ADR-0030). Same class as the batch-evaluate "all failed, recorded
 * done" fix. fix-portal deliberately stays out: its artifact is a portals.yml
 * edit, which needs a config-delta verdict of its own before it can be gated
 * honestly (recorded as a gap in ADR-0030, not silently skipped).
 *
 * @type {ReadonlySet<string>}
 */
export const PERSISTENCE_GATED_KINDS = Object.freeze(new Set(["evaluate", "checkup"]));

/**
 * Count data rows in the checkup ledger (`data/company-checkups.tsv`).
 *
 * `lib/log-checkup.mjs` owns the row schema (locked by
 * tests/checkup-ledger.test.mjs); this counter deliberately re-states only the
 * one thing a persistence gate needs — "is there one more row than before" —
 * because importing the root module into the web bundle couples the gate to a
 * file that is not part of the app. A data row starts with its tracker key
 * (digits or the `?` empty key) followed by a tab, which is exactly how
 * `parseTracker` defines the key; comment headers, blank lines and truncated
 * rows therefore never count.
 *
 * @param {string | undefined} text - Raw ledger file contents (undefined = unreadable/absent).
 * @returns {number}
 */
export function checkupLedgerRowCount(text) {
  if (typeof text !== "string") return 0;
  let n = 0;
  for (const line of text.split("\n")) {
    if (/^(\d+|\?)\t/.test(line.trim())) n++;
  }
  return n;
}

/**
 * 可核验产物的台账行数 —— 门禁真正该数的那个数（ADR-0030 跟进决议，2026-09-17）。
 *
 * WHY: 决议 1 选了「数台账行」而不是「数 reports/ 增量」，因为 HTML 是可选附件
 * （`--html -` 合法）。但**只数行**会漏掉一整类假落盘：行写进来了，它声明的 HTML
 * 却不存在 —— 2026-09-17 `#1022`：该行 10 次 run 全是 0–6s 取消，台账里却有一行
 * 指向从未写出的 `reports/checkups/1022-henan-yijin-yigou-2026-09-17.html`，
 * 门禁照样记「已落盘」。所以「行」的定义收紧为「可核验产物」：
 * 未声明 HTML（`-`/空/截断行，ADR-0030 决议 1 的容忍口径不变）→ 计；
 * 声明了 HTML → 文件必须存在。`--html -` 依然合法，决议 1 不被推翻。
 *
 * @param {string | undefined} text - 台账原文（undefined = 读不到 → 0）
 * @param {(rel: string) => boolean} fileExists - 相对仓库根的 html 路径 → 文件存在？（
 *   route 传 makeCheckupHtmlProbe(root)；缺失即按「不计入」处理，绝不因探针缺失而放宽）
 * @returns {number}
 */
export function checkupArtifactRowCount(text, fileExists) {
  if (typeof text !== "string") return 0;
  const probe = typeof fileExists === "function" ? fileExists : () => false;
  let n = 0;
  for (const line of text.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (!/^(\d+|\?)\t/.test(t)) continue;
    const html = (t.split("\t")[6] ?? "").trim();
    if (!html || html === "-" || probe(html)) n++;
  }
  return n;
}

/**
 * 可核验产物行数，按单个 tracker# 计 —— 批量体检的逐项门禁（ADR-0041 决议 6）。
 *
 * `checkupArtifactRowCount` 是全局计数（单个体检一个 worker 独占一次 run，全局
 * 前后差值就是它的产物）；批量里 N 个 worker 并发写同一份台账，全局差值无法归属
 * 到具体某家——所以按 key 列（tracker#）过滤后再数。行的「可核验」定义与全局版
 * 一致：声明了 HTML 的行必须文件存在，`-`/空/截断行容忍，`?` 空键行只属于 `?`。
 *
 * @param {string | undefined} text - 台账原文（undefined = 读不到 → 0）
 * @param {string} trackerNo - 本项的 tracker 行号（数字字符串）
 * @param {(rel: string) => boolean} fileExists - 同 checkupArtifactRowCount
 * @returns {number}
 */
export function checkupArtifactRowCountForTracker(text, trackerNo, fileExists) {
  if (typeof text !== "string") return 0;
  const key = String(trackerNo ?? "").trim();
  if (!/^\d+$/.test(key)) return 0;
  const probe = typeof fileExists === "function" ? fileExists : () => false;
  let n = 0;
  for (const line of text.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (!t.startsWith(`${key}\t`)) continue;
    const html = (t.split("\t")[6] ?? "").trim();
    if (!html || html === "-" || probe(html)) n++;
  }
  return n;
}

/**
 * 批量体检的汇总事件（纯，ADR-0041 决议 6 诚实门禁）：
 * ok=0 且 failed>0 → `error`（全失败不得伪装 done —— 2026-09-15 批量评估事故
 * 的教训：80/80 零产物仍发 done，卡片落账还触发了刷新）；否则 `done` 带逐项
 * 计数。skippedRunning（在跑跳过）单列，不算失败，error 文案里如实分开陈述。
 *
 * 可选透传服务端墙钟 `startedAt`/`finishedAt`：前端卡片据此覆盖本地 `endedAt`，
 * 使「时长」反映服务端真实执行（#885 卡显示 1h03m 实为 30m：页签休眠污染了前端
 * 墙钟）。未传时绝不新增这两个键（保持既有事件形状，既有 deepEqual 测试不破）。
 *
 * @param {{ok: number, failed: number, skipped?: number, skippedRunning?: number, startedAt?: number, finishedAt?: number}} args
 * @returns {{type: "done", ok: number, failed: number, skipped: number, skippedRunning: number, startedAt?: number, finishedAt?: number} | {type: "error", msg: string, startedAt?: number, finishedAt?: number}}
 */
export function batchCheckupFinalEvent({ ok, failed, skipped = 0, skippedRunning = 0, startedAt, finishedAt }) {
  // 只在拿到真数值时才附键，避免 `{startedAt: undefined}` 破坏既有形状。
  const timing =
    typeof startedAt === "number" && typeof finishedAt === "number"
      ? { startedAt, finishedAt }
      : {};
  if (ok === 0 && failed > 0) {
    return {
      type: "error",
      msg: `All ${failed} checkup(s) failed — no checkup ledger rows were written. See the NOT recorded lines above for per-company reasons.${skippedRunning ? ` ${skippedRunning} row(s) were skipped as already running (those are not failures).` : ""}`,
      ...timing,
    };
  }
  return { type: "done", ok, failed, skipped, skippedRunning, ...timing };
}

/**
 * 门禁用的 HTML 存在性探针：`reports/checkups/` 前缀 + 仓库根容器内 + 真的是文件。
 * 读方不信任台账（同 /api/checkup-report 的立场）——前缀合规不代表路径没有逃逸，
 * 目录也不等于报告。
 *
 * @param {string} root - 仓库根（careerOpsRoot()）
 * @returns {(rel: string) => boolean}
 */
export function makeCheckupHtmlProbe(root) {
  return (rel) => {
    if (typeof rel !== "string" || !rel.startsWith("reports/checkups/")) return false;
    // `reports/checkups/../../secret.txt` 也满足前缀且落在根内——先按段拒绝逃逸，
    // 再交给容器判定（读方不信任台账，两层都要）。
    const segs = rel.split("/");
    if (segs.includes("..")) return false;
    const file = path.join(root, ...segs);
    const within = path.relative(root, file);
    if (within.startsWith("..") || path.isAbsolute(within)) return false;
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
}

/**
 * The evaluate/checkup honesty gate, extracted from route.ts's close handler.
 *
 * It was inline there, which is why it had no test seam and why checkup could
 * silently drift out from under it (ADR-0030). Pure: the caller snapshots its
 * artifact channel and passes the verdict in as `persisted` — evaluate passes
 * `hasNewCompletedReport(reportsBefore, reportEntries())`, checkup passes
 * `checkupArtifactRowCount(after, probe) > checkupArtifactRowCount(before, probe)`
 * (可核验产物行数：声明了 HTML 的行必须有文件，见该函数的 WHY)。Branch order
 * mirrors the original if/else chain exactly; the evaluate message is kept
 * byte-identical.
 *
 * @param {{kind: string, cleanExit: boolean, sawError: boolean, emittedText: boolean, persisted: boolean, timedOut?: boolean}} args
 *   `timedOut` = the harness's own kill timer stopped it (route.ts's `killer`), which is
 *   NOT the CLI's fault and must be reported as such — see the branch below.
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function persistRunOutcome({ kind, cleanExit, sawError, emittedText, persisted, timedOut = false }) {
  // 本地定时器杀的，先于一切判——否则「无 stdout + 非 0 退出」会落进下面的
  // noOutputError 分支，把 30 分钟体检上限读成安装/登录问题（2026-09-17 #682 实测：
  // 卡片写着 "is it installed and authenticated?"，真因是撞了 checkup 的 1_800_000ms
  // 上限）。这类失败该说的是「换个便宜点的做法」，不是「去查装没装 CLI」。
  if (timedOut) {
    const limit = kind === "checkup" ? "30-minute checkup limit" : "time limit";
    const head = `This run hit the harness's ${limit} and was stopped — not an install or auth problem.`;
    if (PERSISTENCE_GATED_KINDS.has(kind) && !persisted) {
      const channel = kind === "checkup" ? "data/company-checkups.tsv" : "a report";
      return { ok: false, message: `${head} Nothing was persisted (no ${channel} entry). Re-run it with a smaller research budget.` };
    }
    return {
      ok: false,
      message: persisted ? `${head} Its artifact did land — verify it before re-running.` : `${head} Nothing was persisted.`,
    };
  }
  // A CLI that produced no output at all is the same failure mode whether it
  // was evaluating or running a checkup — one place for the condition/message
  // pair (formerly route.ts's noOutputError).
  if (!emittedText && !sawError && !cleanExit) {
    return { ok: false, message: "The CLI exited with an error — is it installed and authenticated?" };
  }
  if (!emittedText && !sawError) {
    return { ok: false, message: "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)" };
  }
  if (PERSISTENCE_GATED_KINDS.has(kind) && !persisted) {
    const message = kind === "checkup"
      ? "This checkup finished without a usable row in the checkup ledger (data/company-checkups.tsv) — no new row landed, or the row it added names an HTML report that isn't there. Nothing was persisted, so it's not recorded. Re-run it to verify."
      : "This evaluation didn't save a report, so it's not in your tracker. Full evaluation is verified on Claude Code.";
    return { ok: false, message };
  }
  if (!cleanExit || sawError) {
    return { ok: false, message: "This run hit an error before finishing, so it isn't recorded as a confident result — re-run it to verify." };
  }
  return { ok: true };
}

/** 失败证据的候选行（闭集，声明处即权威）。为什么要挑：本机这类失败——代理层的
 *  `API Error: Content block not found`、拒绝语「抱歉，内容可能包含敏感信息…」——走的是
 *  stdout 的 assistant text，而 ADR-0027 的 stderrTail 在本机账本里 0 条命中，信号根本
 *  不在那条通道上。不挑行的话，十几次搜索的空结果与工具回显会把死因淹掉。 */
const FAILURE_EVIDENCE_RE = /API Error|敏感|refus|rate[ -]?limit|overloaded|\bquota\b|\bError:|timeout|ECONN/i;

/**
 * 从 agent 的可见正文里挑出失败证据（ADR-0034 决议 2）。
 *
 * 相邻重复折叠成 `×N`（#119 那次同一句 `API Error` 出现了 26 次，逐行抄 26 遍等于没有
 * 信息）；超上限时保留**靠后**的行——离退出最近的几行才是死因。纯函数：调用方累积正文，
 * 何时入账本由 route.ts 决定。
 *
 * @param {string | null | undefined} text - agent 的可见正文（stdout 侧累积）
 * @param {{maxLines?: number, maxChars?: number}} [opts]
 * @returns {string} 证据串；无命中返回空串（调用方据此不加这一段）
 */
export function failureEvidence(text, { maxLines = 6, maxChars = 600 } = {}) {
  if (typeof text !== "string" || !text) return "";
  const folded = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !FAILURE_EVIDENCE_RE.test(line)) continue;
    const last = folded[folded.length - 1];
    if (last && last.line === line) last.count += 1;
    else folded.push({ line, count: 1 });
  }
  if (folded.length === 0) return "";
  return folded
    .slice(-Math.max(1, maxLines))
    .map((e) => (e.count > 1 ? `${e.line} ×${e.count}` : e.line))
    .join(" ｜ ")
    .slice(0, maxChars);
}

/**
 * 失败终态的账本 msg（ADR-0034 决议 3）：一句话原因 + 可选的两段证据。
 *
 * 上限 800（原 300）：checkup 的门禁文案本身就 175 字，300 的老上限会把证据整段截掉——
 * 不提升上限，补丁等于没打。stderr 段取尾部 200 字，保证 stdout 那段（真正的信号所在）
 * 不会被挤掉；两段谁有算谁。整体仍是纯文本、单行、无换行（TSV/JSONL 与 UI 都是单行渲染）。
 *
 * @param {string | null | undefined} message - 门禁/CLI 的一句话原因
 * @param {{stderrTail?: string, stdoutTail?: string, maxChars?: number}} [opts]
 * @returns {string}
 */
export function failureLedgerMsg(message, { stderrTail, stdoutTail, maxChars = 800 } = {}) {
  const parts = [String(message ?? "").trim()];
  if (stderrTail) parts.push(`stderr: ${String(stderrTail).slice(-200)}`);
  if (stdoutTail) parts.push(`输出尾部: ${stdoutTail}`);
  return parts.filter(Boolean).join(" ｜ ").slice(0, maxChars);
}
