// Both spawners are needed here, and the distinction matters: the agent CLI goes
// through spawnHeadlessCli (which closes stdin so `codex exec` can't hang waiting
// on it, #2085), while the PDF render is a plain Node child process with no CLI
// sandbox in the way (#2172) and so passes `spawn` itself to renderAndMarkPdf.
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after } from "next/server";
import { resolveCli } from "@/lib/clis";
import { accumulateTokens, hasNewCompletedReport, isFatalGenericStderr, withModelFlag } from "@/lib/run-cli-support.mjs";
import { spawnHeadlessCli, terminateCli } from "@/lib/spawn-cli.mjs";
import { careerOpsRoot, readMemory, findReportFile, readInbox, readScanDates, findCheckupTarget, rootScript } from "@/lib/career-ops";
import { checkupDispatchText } from "@/lib/checkup-request.mjs";
import { readAppConfig } from "@/lib/app-config";
import { resolvePdfPaths, type PdfPaths } from "@/lib/pdf-paths.mjs";
import { renderAndMarkPdf, writeCvHtml, pdfRunOutcome } from "@/lib/pdf-render.mjs";
import { createCvEnvelopeFilter, type CvEnvelope } from "@/lib/cv-envelope.mjs";
import { buildPrompt, isShellSafeCompanyName } from "@/lib/run-prompts.mjs";
import { claudeCliArgs } from "@/lib/claude-invocation.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { acquire, release, __setSizeSource, DEFAULT_POOL_SIZE } from "@/lib/core/concurrency-pool";
import { registerRun, setCancelHandler, publish, completeRun } from "@/lib/core/run-events";
import { appendRunRecord } from "@/lib/run-ledger.mjs";

// Feed the global concurrency pool the live configured size (app-config), re-read
// on every dispatch so a config-page edit takes effect without restart.
__setSizeSource(() => readAppConfig().concurrencyPool ?? DEFAULT_POOL_SIZE);

// 评估耗时埋点 (ADR-0016/0017): the pdf kind is READ-ONLY on the Claude path —
// #2172 denied it Bash and it must never regain that — so the agent cannot time
// itself. The backend owns the pdf step's boundaries instead (spawn → confirmed
// render) and logs through log-eval-timing.mjs so the TSV keeps a single
// writer. Fire-and-forget: a failed timing call never fails the run.
function logEvalTiming(reportNum: string, phase: "start" | "end") {
  execFile(
    process.execPath,
    [path.join(careerOpsRoot(), "log-eval-timing.mjs"), reportNum, "pdf", phase],
    { cwd: careerOpsRoot() },
    () => {},
  );
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // a real oferta evaluation / pdf-mode CV tailoring + render is heavy and multi-step

// ADR-0020 transport: POST /api/run does NOT stream the worker's output back on
// its own response anymore. It validates, registers a runId on the event bus
// (lib/core/run-events.ts), returns {runId} IMMEDIATELY, and the pipeline runs
// in the background publishing every event to the bus. GET /api/events
// multiplexes ALL runs onto ONE held connection per tab.
//
// Why: each task used to hold its own streaming response — including while
// QUEUED (the old route returned its stream before the pool granted a slot) —
// and HTTP/1.1 browsers cap same-origin sockets at 6. ~6 concurrent tasks then
// starved every NEW request (clicks on other features did nothing) until the
// tasks finished. One multiplexed channel makes the per-task connection cost 0.
//
// Behavior change: with no held response there is no client disconnect to
// cancel a run — closing the tab no longer kills the CLI (it finishes
// headless, like extension-sourced batches always have). Cancellation goes
// through POST /api/run/cancel (the worker card's X button).

export async function POST(req: Request) {
  let body: { kind?: string; input?: string; cliId?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { kind = "evaluate", input, cliId, model } = body;
  if (!input || !cliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;

  // These run the REAL core (modes/scripts), not just data — fail clearly if the
  // root is incomplete instead of faking it.
  const needsScript: Record<string, string> = { evaluate: "modes/oferta.md", "fix-portal": "verify-portals.mjs", pdf: "generate-pdf.mjs", checkup: "modes/_custom.md" };
  const required = needsScript[kind];
  if (required && !fs.existsSync(path.join(careerOpsRoot(), required))) {
    return new Response(
      JSON.stringify({
        error: `This needs a complete career-ops checkout (${required}). CAREER_OPS_ROOT has data only — point it at a full checkout.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // fix-portal's prompt puts this straight into a shell command the agent runs, and
  // a company name can arrive from a public ATS listing rather than the user's own
  // typing. Refuse rather than sanitize: a silently rewritten name would repair the
  // wrong portal.
  if (kind === "fix-portal" && !isShellSafeCompanyName(input)) {
    return new Response(
      JSON.stringify({ error: "That company name has characters I can't safely pass to the portal checker — rename it in portals.yml first." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // An A–F score is meaningless without a CV to score against — the CLI would
  // hallucinate a fit narrative and still emit a VERDICT. Require cv.md first.
  if ((kind === "evaluate" || kind === "pdf") && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
    return new Response(
      JSON.stringify({ error: "Add your CV first so I can score this against you — drop it on the home page." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Register the run BEFORE returning the runId so the bus already has the
  // record when the first events flow.
  const runId = randomUUID();
  const startedAt = Date.now();
  registerRun(runId);

  // Server-side run ledger (B4-class observability): a terminated run must be
  // visible even when no UI card exists (API-dispatched runs, another tab).
  // Recorded once per run at the terminal send/cancel/crash — see recordEnd.
  const checkupTarget = kind === "checkup" ? findCheckupTarget(String(input)) : null;
  const ledgerTitle = checkupTarget?.ok
    ? `公司体检：${checkupTarget.company}`
    : `${kind} ${input}`;
  let endRecorded = false;
  const recordEnd = (status: "done" | "error", msg?: string) => {
    if (endRecorded) return;
    endRecorded = true;
    try {
      appendRunRecord(careerOpsRoot(), {
        id: runId,
        kind,
        input,
        title: ledgerTitle,
        page: kind === "checkup" ? `/pipeline/${input}` : undefined,
        status,
        startedAt,
        finishedAt: Date.now(),
        msg: msg ? String(msg).slice(0, 300) : undefined,
      });
    } catch (e) {
      console.error("[run-ledger] append failed:", e instanceof Error ? e.message : e);
    }
  };

  // 公司体检审计行（ADR-0027 决议 3）：同步写一条已标记的 agent-inbox 行
  // （含本 runId），关闭双击去重窗口；drain 规则会跳过已标记的体检请求。
  if (checkupTarget?.ok) {
    const auditLine = checkupDispatchText({ n: String(input), company: checkupTarget.company, runId });
    execFile(
      process.execPath,
      [rootScript("agent-inbox"), "add-done", auditLine, "--result", `dispatched worker ${runId}`],
      { cwd: careerOpsRoot(), timeout: 15_000, env: process.env },
      (err) => {
        if (err) console.error("[checkup] audit line failed:", err.message);
      },
    );
  }

  after(async () => {
    try {
      await runPipeline({ runId, kind, input, cliId, model, spec, binPath, recordEnd });
    } catch (e) {
      // Nothing else catches this promise — a crash here must still terminate
      // the run on the bus instead of leaving it open until process shutdown.
      const msg = `Worker crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      publish(runId, { type: "error", msg });
      recordEnd("error", msg);
      completeRun(runId);
    }
  });

  return Response.json({ runId });
}

/** The old streaming pipeline, unchanged in substance — only the transport
 * moved from "this response's ReadableStream" to the run-events bus. */
async function runPipeline({
  runId,
  kind,
  input,
  cliId,
  model,
  spec,
  binPath,
  recordEnd,
}: {
  runId: string;
  kind: string;
  input: string;
  cliId: string;
  model?: string;
  spec: import("@/lib/clis").CliSpec;
  binPath: string;
  /** Server run-ledger recorder (once per run; passed in from POST scope). */
  recordEnd: (status: "done" | "error", msg?: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);

  // Precompute deterministic scratch + final paths so the agent never chooses
  // its own filenames — the backend owns naming, writing (#2185) and rendering
  // (#2172). Nothing is cleared first: writeCvHtml rewrites the HTML
  // from this run's freshly parsed envelope before any render, and the agent is
  // no longer told these paths, so a stale file cannot survive into a render.
  let pdfPaths: PdfPaths | undefined;
  if (kind === "pdf") {
    const pathsResult = resolvePdfPaths(input, today, careerOpsRoot(), findReportFile);
    if (!pathsResult.ok) {
      publish(runId, { type: "error", msg: pathsResult.error });
      completeRun(runId);
      return;
    }
    pdfPaths = pathsResult.paths;
  }

  // Resolve the posting date HERE rather than asking the agent for it. The
  // scanner already wrote it from the provider's own `offer.postedAt`, so this
  // copies a recorded value instead of inviting a guess — and modes/oferta.md is
  // explicit that a guessed date is worse than an absent one (the POSTED column
  // renders absent as `—`, a wrong date as a fresh req). Unknown URL → undefined
  // → the prompt writes no segment at all.
  const postedAt =
    kind === "evaluate"
      ? readInbox().find((j) => j.url === input)?.postedAt ?? readScanDates().get(input)
      : undefined;
  const prompt = buildPrompt({ kind, input, memory: readMemory(), today, postedAt, unknownEmployer: readAppConfig().unknownEmployer });

  const isClaude = cliId === "claude";
  // Which tools each kind gets, and the whole claude argv, live in
  // claude-invocation.mjs — see its header for the policy and for why it is asserted on
  // built values rather than on this file's source. NEVER auto-submits; that
  // remains a prompt-level guarantee.
  // Non-Claude CLIs get no tool flags from spec.args() at all, so their agents
  // stay unrestricted here. That gap is route-wide (it applies to 'evaluate' too),
  // not specific to pdf, and each CLI needs its own mechanism researched — tracked
  // as #2507 rather than half-fixed here. On those CLIs the backend is the only
  // INTENDED writer — the agent is not asked to write — but that is mitigation, not
  // enforcement: the capability is still there for an injected posting to reach.
  // A CLI with its own structured stream gets the argv that turns it on, so its
  // stdout matches spec.parseEvent below; spec.args stays the plain-text argv the
  // envelope-parsing routes rely on.
  const baseArgs = isClaude ? claudeCliArgs({ kind, prompt }) : (spec.streamArgs ?? spec.args)(prompt);
  // The config page's model picker applies to EVERY CLI uniformly. Absent a saved
  // model (or a CLI with no model flag), withModelFlag returns the args untouched
  // and the CLI keeps its own default.
  const args = withModelFlag(baseArgs, spec.model, model);

  // For write-needing kinds, snapshot reports/ so we can verify the worker
  // actually persisted (non-Claude CLIs lack Write auth and silently no-op).
  // Names, not a count: reserving a number writes reports/NNN-RESERVED.md and the
  // final report REPLACES it, so the `.md` count is unchanged and a count-delta
  // gate reported "didn't save a report" for an evaluation that saved fine (#2085).
  const reportsDir = path.join(careerOpsRoot(), "reports");
  const reportEntries = () => {
    try {
      return fs.readdirSync(reportsDir);
    } catch {
      return [];
    }
  };
  const persists = kind === "evaluate";
  const reportsBefore = persists ? reportEntries() : [];

  // Global concurrency: queue for a slot in the global CLI-concurrency pool
  // BEFORE touching the write token or spawning. A full pool keeps the task
  // queued (visible as 排队中) instead of spawning another heavyweight agent
  // CLI — ADR-0014 Q1/Q4. Queued tasks no longer hold an HTTP response: their
  // status reaches the client through the /api/events channel (ADR-0020).
  const poolHandle = acquire({ url: input, title: input, source: "run" });

  // Spawned/guarded only AFTER the pool grants a slot. `child`/`writeToken` are
  // outer lets so cancel() can reach them whether the run is queued
  // (null → cancel just dequeues and closes the run) or running (→ terminate
  // the child + release both the token and the pool slot).
  let child: ReturnType<typeof spawnHeadlessCli> | null = null;
  let writeToken: number | null = null;
  let poolReleased = false;
  const releasePoolOnce = () => {
    if (poolReleased) return;
    poolReleased = true;
    release(poolHandle.id);
  };

  // `terminal` marks the run as over: no more events published, resources
  // released. Cancellation now arrives via setCancelHandler (POST /api/run/cancel)
  // instead of a stream-disconnect — there is no held response to disconnect.
  let terminal = false;
  // Resolved when the run reaches its terminal state (close() or a cancel), so
  // the try body below can AWAIT it. Without that await the body falls straight
  // through to `finally`, which closes the run the instant the child handlers
  // are registered — `terminal` flips true while the CLI is still running and
  // every later event (the honesty gate's done/error, pdf's render) is silently
  // swallowed. Found 2026-09-14 via web/qa-run-close.mjs (regression of 3bb566b).
  let runSettled: (() => void) | null = null;
  const settle = () => { runSettled?.(); runSettled = null; };
  let killer: ReturnType<typeof setTimeout> | undefined;
  // pdf-kind's render+mark work (renderPdf, below) keeps running detached even
  // after the agent child closes — and even after a cancel. Track its promise so
  // cancel() can defer releasing writeToken until that work actually settles,
  // instead of releasing the tracker-delete guard while mark-pdf-ready.mjs is
  // still actively writing applications.md.
  let pdfRenderPromise: Promise<void> | null = null;
  let writeTokenReleased = false;
  const releaseWriteTokenOnce = () => {
    if (writeToken !== null && !writeTokenReleased) {
      writeTokenReleased = true;
      releaseTrackerWrite(writeToken);
    }
  };
  // ADR-0027 账本观测：最后 ~1200 字符原始 stderr（去 ANSI），随 error 终态
  // 入账本——通用门文案之下的真实根因线索。由 stderr data handler 更新。
  let stderrTail = "";
  const send = (obj: { type: string; [key: string]: unknown }) => {
    if (terminal) return;
    publish(runId, obj);
    if (obj.type === "done") recordEnd("done");
    else if (obj.type === "error")
      recordEnd("error", String(obj.msg ?? "") + (stderrTail ? ` ｜ stderr: ${stderrTail}` : ""));
  };
  const keepalive = setInterval(() => send({ type: "keepalive" }), 10_000);
  const close = () => {
    settle(); // idempotent — also fires when a cancel already terminal'd the run
    if (terminal) return;
    terminal = true;
    clearInterval(keepalive);
    if (killer) clearTimeout(killer);
    releaseWriteTokenOnce();
    releasePoolOnce();
    completeRun(runId);
  };

  // Cancel path (worker card X button → /api/run/cancel). Mirrors the old
  // stream-cancel(): kill the child tree / dequeue from the pool, release the
  // guards, and terminate the run on the bus.
  setCancelHandler(runId, () => {
    settle(); // a cancel is terminal too — the awaited body must not hang
    if (terminal) return;
    terminal = true;
    recordEnd("error", "cancelled by user");
    clearInterval(keepalive);
    if (killer) clearTimeout(killer);
    if (child) {
      // 必须按进程树终止：单杀 CLI 主进程会让它派生的子进程（如 Git find.exe）
      // 残留成孤儿，持续空转占 CPU。
      terminateCli(child);
      if (pdfRenderPromise) {
        // Render/mark keeps running after the cancel — wait for it to settle
        // before releasing the guard, so a concurrent tracker delete can't race
        // mark-pdf-ready.mjs's still-in-flight write.
        pdfRenderPromise.finally(() => {
          releaseWriteTokenOnce();
          releasePoolOnce();
        });
      } else {
        releaseWriteTokenOnce();
        releasePoolOnce();
      }
    } else {
      // Still queued (no child spawned) — dequeue from the pool so IT never
      // grants the slot after we've terminated; the awaiting pipeline below sees
      // `ready` resolve false and exits without spawning.
      poolHandle.cancel();
      releasePoolOnce();
    }
    publish(runId, { type: "error", msg: "Cancelled" });
    completeRun(runId);
  });

  {
    let buf = "";
    let emittedText = false; // any assistant text delta → the CLI actually ran
    let sawError = false;
    let stderrBuf = "";
    // Fallback for a CLI with no CliSpec.stderrIsFatal of its own. Moved into
    // run-cli-support.mjs beside the per-CLI classifiers so it has a reachable
    // test: as an inline regex in this closure nothing could assert it, which
    // is how a bare `auth` came to match "Authentication successful" and mark a
    // successful run as failed on six of the eight runtimes (#1974).
    const isFatalStderr = spec.stderrIsFatal ?? isFatalGenericStderr;
    const flagStderrLine = (line: string) => {
      if (!line.trim() || !isFatalStderr(line)) return;
      sawError = true;
      send({ type: "error", msg: line.trim().slice(0, 200) });
    };
    let lastTokens = 0; // per-run token cost from the CLI's structured usage event (#6) — local only
    let lastCostUsd: number | null = null;
    // pdf-mode's agent only tailors content now (rendering moved to the
    // backend, #2172) — but its killMs still has to leave real headroom
    // inside the route's overall maxDuration (800s): the render+mark phase
    // (renderPdf, below) starts only after this timer's window and has no
    // timeout of its own, so an agent that runs close to its full budget
    // would otherwise leave the platform's hard maxDuration cutoff to kill
    // generate-pdf.mjs mid-render. 600s agent / ~200s render is ample —
    // a Chromium PDF render normally takes low tens of seconds even with a
    // cold Playwright launch.
    //
    // An oferta evaluation is heavier than it looks on a CLI that auto-loads
    // a full MCP surface (Playwright, codegraph, doctor, company-history,
    // Block-G research) before it even writes the report + TSV + merge. On
    // OpenCode that chain routinely exceeded the old 285s and the worker was
    // killed mid-report — the reserve sentinel got written but no report, so
    // the honesty gate reported "didn't save a report". Evaluate has no
    // render phase to reserve headroom for, so give it the full 600s too.
    // checkup（公司体检，ADR-0027）是重调研：opencode 实测约 10 分钟起步，
    // 600s 的通用 kill 定时器会在它写完 HTML/台账、正要写附录时 SIGTERM
    // （2026-09-15 实测——131/119/124/916 四次「零产物失败」的真根因）。
    // 30 分钟给足余量；evaluate/pdf 维持 600s。
    const killMs = kind === "checkup" ? 1_800_000 : 600_000;
    // `killer` is armed AFTER spawn below (the CLI child is null while queued,
    // so there is nothing to kill and terminateCli(null) would throw).

    // pdf's CV arrives inline in a <<cv-html>> envelope instead of being written
    // by the agent (#2185). The filter keeps every byte for the backend while
    // holding the 15-25 KB body out of the run log, which is the agent's
    // narration — see cv-envelope.mjs.
    const cvFilter = kind === "pdf" ? createCvEnvelopeFilter() : null;
    // While the agent emits the 15-25 KB <<cv-html>> envelope, cvFilter swallows
    // every byte, so the worker log goes completely silent for as long as the
    // model takes to write the CV — a minute or more. The bus-level keepalive
    // (armed next to send/close above) covers that phase; consumers ignore
    // unknown event types, so this is safe for older clients too.

    /** Surface non-fatal issues in the run log rather than only a server log. */
    const sendWarnings = (warnings: string[]) => {
      for (const w of warnings) send({ type: "text", text: `⚠️ ${w}\n` });
    };
    /** Persist the emitted CV; streams the reason and returns false on failure. */
    const saveCv = (paths: PdfPaths, envelope: CvEnvelope) => {
      const written = writeCvHtml({ pdfPaths: paths, html: envelope.html });
      if (!written.ok) send({ type: "error", msg: written.error.slice(0, 200) });
      return written.ok;
    };

    // One dispatch for every structured CLI: the per-CLI knowledge (which event
    // means text/tool/status/usage) lives in run-cli-support.mjs behind
    // spec.parseEvent, so adding the next such CLI needs no change here.
    // Shared with the close-time flush below, so a final JSONL line the CLI never
    // newline-terminates before exiting isn't dropped along with the usage event
    // it carries.
    const processParsedLine = (line: string) => {
      if (!spec.parseEvent) return;
      const ev = spec.parseEvent(line);
      if (ev?.text) {
        emittedText = true;
        // sendAgentText, NEVER send: pdf's CV arrives inside the agent's text as a
        // <<cv-html>> envelope, so parsed text has to reach cvFilter too or the
        // backend has nothing to save and the 25 KB body floods the run log (#2185).
        sendAgentText(ev.text);
      }
      if (ev?.tool) send({ type: "tool", name: ev.tool });
      if (ev?.status) send({ type: "status", label: ev.status });
      // Accumulated, not assigned: usage events are per-turn, so overwriting made a
      // multi-turn run report only its last turn. The authoritative "done" is sent
      // on close, so the honesty gate decides done-vs-error first.
      lastTokens = accumulateTokens(lastTokens, ev);
      if (typeof ev?.costUsd === "number") lastCostUsd = ev.costUsd;
      if (ev?.error) {
        sawError = true;
        send({ type: "error", msg: ev.error.slice(0, 200) });
      }
    };
    const sendAgentText = (text: string) => {
      const visible = cvFilter ? cvFilter.push(text) : text;
      if (visible) send({ type: "text", text: visible });
    };

    try {
      // Wait for a global-pool slot before spawning. While queued the run shows
      // as 排队中 in the worker list (via the active-runs snapshot — no held
      // HTTP response anymore, ADR-0020). If the user cancels it mid-queue,
      // ready resolves false and we terminate with an explicit cancelled
      // signal — the CLI never spawned and the pool slot is never claimed.
      const started = await poolHandle.ready;
      if (!started) {
        // Cancel while queued: the cancel handler already published the error
        // and completed the run — nothing to do here.
        return;
      }
      // Only NOW, with a slot in hand, hold the tracker-write token (ADR-0014
      // Q4 — a long queue must not keep n write tokens held) and spawn the CLI.
      // Tracker-mutating runs guard the row-delete race (tracker.mjs delete
      // doesn't share merge-tracker's lock — see run-registry).
      writeToken = kind === "evaluate" || kind === "pdf" ? acquireTrackerWrite() : null;
      // stdin must reach EOF or the CLI waits on piped input that never comes:
      // Codex's `exec` blocks reading stdin, hangs until the kill timer, then
      // reports a generic auth-flavoured error (#1973 fixed it via an inline
      // stdio:["ignore",…], generalized into spawnHeadlessCli).
      child = spawnHeadlessCli(binPath, args, { cwd: careerOpsRoot(), env: process.env });
      if (kind === "pdf") logEvalTiming(String(input), "start");
      // Decode once on the stream, not per chunk: Buffer#toString() decodes each
      // chunk independently, so a boundary inside a multi-byte UTF-8 sequence
      // yields a replacement character and mis-decodes the bytes after it — the
      // CV now flows through here (#2185).
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      killer = setTimeout(() => {
        if (child) terminateCli(child);
      }, killMs);

      child.stdout.on("data", (chunk: string) => {
        if (terminal) return;
        if (!spec.parseEvent) {
          emittedText = true;
          sendAgentText(chunk);
          return;
        }
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) processParsedLine(line);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        // Match on COMPLETE lines. A chunk boundary can fall mid-word, so testing a
        // raw chunk both misses an error split across two of them and can match a
        // fragment that is not the word it looks like. sawError feeds pdfRunOutcome,
        // where a false positive fails a run whose PDF rendered fine, so the
        // boundary has to be settled before the regex sees it.
        stderrBuf += chunk;
        // ADR-0027 账本观测：终端态只有通用门文案时，stderr 尾巴是唯一的根因
        // 线索（strip ANSI，保最后 ~1200 字符）。
        stderrTail = (stderrTail + chunk).slice(-1200).replace(/\x1b\[[0-9;]*m/g, "");
        let nl;
        while ((nl = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, nl);
          stderrBuf = stderrBuf.slice(nl + 1);
          flagStderrLine(line);
        }
      });
      // Render + mark-tracker-ready live in pdf-render.mjs (plain, dependency-
      // injected, unit-tested) so the render-then-mark orchestration isn't
      // buried untested inside this transport-layer closure. Runs generate-
      // pdf.mjs and mark-pdf-ready.mjs as plain Node child processes — no agent
      // CLI or its sandbox involved — so a browser launch never depends on an
      // interactive approval nobody is present to grant in a headless/web-
      // triggered run (#2172). The tracker is marked ✅ only after a CONFIRMED
      // successful render, not optimistically — same honesty-gate discipline as
      // the evaluate path below.
      const renderPdf = async (paths: PdfPaths, format: "letter" | "a4") => {
        send({ type: "status", label: "Rendering PDF…" });
        // renderAndMarkPdf is designed to resolve, never throw — but this is
        // the one place nothing else awaits or catches this promise, so an
        // unexpected exception here must still close the run instead of
        // leaving it open until process shutdown.
        try {
          const result = await renderAndMarkPdf({
            spawnFn: spawn,
            execPath: process.execPath,
            root: careerOpsRoot(),
            pdfPaths: paths,
            format,
            reportNum: input,
          });
          if (result.kind === "render-failed") {
            send({ type: "error", msg: result.error.slice(0, 200) });
            return;
          }
          // Non-fatal issues (a defaulted page format, a tracker row not marked) still
          // surface here rather than only in a server log nobody sees.
          sendWarnings(result.warnings);
          // Confirmed successful render → close the pdf step's timing (评估耗时埋点).
          logEvalTiming(String(input), "end");
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        } catch (e) {
          send({ type: "error", msg: `PDF rendering crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
        } finally {
          close();
        }
      };

      child.on("error", (e) => { send({ type: "error", msg: e.message }); close(); });
      child.on("close", (code) => {
        // A cancel can fire (killing `child`) before this event finally arrives —
        // killing a process doesn't make its 'close' event disappear, just delays
        // it. Without this guard a pdf run could still start a brand-new render
        // (and re-touch the tracker) after the run is already terminated and its
        // writeToken guard released.
        if (terminal) return;
        // A trailing line with no newline would otherwise never be tested.
        if (stderrBuf) { flagStderrLine(stderrBuf); stderrBuf = ""; }
        // A final JSONL line with no trailing newline stays in `buf` forever
        // otherwise — flush it through the same parser so the usage/result event it
        // usually carries (the last one of a run) isn't lost. Ahead of the pdf branch,
        // not just the evaluate gate: the pdf path reports lastTokens too.
        const trailing = buf.trim();
        if (trailing) {
          buf = "";
          processParsedLine(trailing);
        }
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        // Shared by both honesty gates below — the pdf gate receives it as
        // pdfRunOutcome's noOutputMessage — because a CLI that produced no output at
        // all is the same failure mode whether it was evaluating or tailoring
        // a PDF — one place for the condition/message pair instead of two.
        const noOutputError = (): string | null => {
          if (!emittedText && !sawError && !cleanExit) return "The CLI exited with an error — is it installed and authenticated?";
          if (!emittedText && !sawError) return "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)";
          return null;
        };

        if (kind === "pdf") {
          // Release any text the filter was still holding, so the log keeps the
          // agent's closing narration and its VERDICT line.
          const tail = cvFilter?.flush();
          if (tail) send({ type: "text", text: tail });
          // The artifact check moved from the filesystem to the stream (#2185):
          // whether pdfPaths.html exists says nothing now that the backend is its
          // only writer. pdfRunOutcome owns the decision and the message.
          const envelope = cvFilter?.result();
          const outcome = pdfRunOutcome({
            envelope,
            noOutputMessage: noOutputError(),
            sawError,
            cleanExit,
            hasPaths: pdfPaths !== undefined,
          });
          if (!outcome.ok) {
            send({ type: "error", msg: outcome.message });
          } else if (!pdfPaths || envelope?.ok !== true) {
            // Unreachable: pdfRunOutcome validated both via hasPaths/envelope.ok.
            // Kept for narrowing, but it must REPORT rather than fall through to a
            // bare close() — a run that ends with neither error nor done is the
            // one outcome this handler exists to prevent.
            send({ type: "error", msg: "Internal error: the pdf run passed its gate with no CV to save — please report this." });
          } else {
            sendWarnings(envelope.warnings);
            if (saveCv(pdfPaths, envelope)) {
              // Tracked so cancel() can defer releasing writeToken until this
              // settles; close() happens once rendering finishes, not here.
              pdfRenderPromise = renderPdf(pdfPaths, envelope.format);
              return;
            }
            // saveCv already published the specific reason.
          }
          return close();
        }

        const wroteReport = hasNewCompletedReport(reportsBefore, reportEntries());
        // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit,
        // real output, AND (for evaluations) a report actually written. Anything else
        // is surfaced — an errored run must never be banked as a confident score.
        const baseErr = noOutputError();
        if (baseErr) {
          send({ type: "error", msg: baseErr });
        } else if (persists && !wroteReport) {
          // The worker ran but never wrote the report/tracker row (e.g. a CLI
          // without file-write authorization) — surface it instead of a fake score.
          send({ type: "error", msg: "This evaluation didn't save a report, so it's not in your tracker. Full evaluation is verified on Claude Code." });
        } else if (!cleanExit || sawError) {
          // Produced output (maybe even a report) but did NOT finish cleanly — flag it
          // instead of recording a confident score off a half-finished run.
          send({ type: "error", msg: "This run hit an error before finishing, so it isn't recorded as a confident result — re-run it to verify." });
        } else {
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        }
        close();
      });

      // Hold the try body open until a terminal handler runs (close() via the
      // child's error/close events, pdf's own finally, or a cancel). Reaching
      // `finally` earlier closes the run before the CLI has said anything.
      await new Promise<void>((resolve) => { runSettled = resolve; });
    } finally {
      // The run must ALWAYS terminate on the bus, whatever path it takes —
      // a thrown parse/spawn error must not leave a zombie "running" entry or
      // a held pool slot / write token (the old stream transport relied on the
      // response dying with the request; the background pipeline has no such
      // safety net and needs this explicitly). EXCEPT the pdf render path: it
      // deliberately outlives this scope and its own finally calls close().
      if (!pdfRenderPromise) close();
    }
  }
}
