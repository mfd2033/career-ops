// Batch checkup — the pipeline EVALUATED tab's "check up N selected" path (ADR-0041).
//
// Runs the SAME engine as a single checkup (/api/run kind:"checkup"): the CLI +
// model picked on the config page, the SAME checkup prompt (buildPrompt kind
// "checkup" — the pointer to modes/_custom.md's「公司体检」workflow, with the
// ADR-0035 pre-resolved company injected), and the SAME honesty gate (green
// requires a clean exit AND a new verifiable ledger row for THAT tracker#).
// Where it differs is ORCHESTRATION, mirroring /api/batch-evaluate:
//
//   A single checkup prompt needs NO report-number reservation and NO tracker
//   merge — its canonical artifacts are (a) an HTML file keyed by the tracker#
//   (`reports/checkups/{n}-{slug}-{date}.html`), (b) ONE ledger row appended
//   via log-checkup.mjs under the same tracker#, and (c) an appendix appended
//   to ITS OWN evaluation report. Every worker owns its tracker#, so there is
//   no shared mutable state: N workers can run fully in parallel (bounded by
//   MAX_PARALLEL and the global concurrency pool) with no range reservation
//   and no merge step — unlike batch-evaluate, which must serialize those.
//
// Streams NDJSON events the client job runner parses:
// {type:"status"|"text"|"item"|"done"|"error"|"keepalive"} — one "item" per
// selected tracker row, carrying {n, company, ok, star, reason}.
//
// ADR-0041 decision 6 (honesty gate): each worker's persistence is verified
// per-tracker# (checkupArtifactRowCountForTracker — the batch analogue of
// /api/run's global before/after count), each failed item carries a reason,
// and ok===0 && failed>0 ends in `error`, never a green `done` (the
// 2026-09-15 batch-evaluate lesson: 80/80 failures still banked a done card).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerBatchRun, recordBatchItem, completeBatchRun, getBatchItems } from "@/lib/batch-items.mjs";
import { appendRunRecord } from "@/lib/run-ledger.mjs";
import { buildBatchLedgerRecord } from "@/lib/batch-ledger.mjs";
import { buildBatchChildRecord } from "@/lib/batch-child-ledger.mjs";
import { resolveCli } from "@/lib/clis";
import {
  withModelFlag,
  isFatalGenericStderr,
  makeCheckupHtmlProbe,
  checkupArtifactRowCountForTracker,
  batchCheckupFinalEvent,
} from "@/lib/run-cli-support.mjs";
import { permissionFlags } from "@/lib/claude-invocation.mjs";
import { spawnHeadlessCli, terminateCli } from "@/lib/spawn-cli.mjs";
import { careerOpsRoot, readMemory, findCheckupTarget } from "@/lib/career-ops";
import { listLiveCheckups } from "@/lib/checkup-live.mjs";
import { decideBatchCheckupConflict } from "@/lib/checkup-request.mjs";
import { readAppConfig } from "@/lib/app-config";
import { buildPrompt } from "@/lib/run-prompts.mjs";
import { acquire, release, __setSizeSource, DEFAULT_POOL_SIZE, type PoolHandle } from "@/lib/core/concurrency-pool";

// Feed the global concurrency pool the live configured size (app-config), re-read
// on every dispatch so a config-page edit takes effect without restart. Same
// wiring as /api/batch-evaluate — the two batch features share ONE pool config.
__setSizeSource(() => readAppConfig().concurrencyPool ?? DEFAULT_POOL_SIZE);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const MAX_ITEMS = 20; // same per-batch cap as /api/batch-evaluate (ADR-0041 决议 1)
const MAX_PARALLEL = 3; // shared with batch-evaluate: browser-scraping workers are anti-bot sensitive
// Same per-worker wall-clock cap /api/run gives kind:"checkup" (runaway-research
// guard: #582/#682 burned 30 minutes each and persisted nothing).
const CHECKUP_WORKER_KILL_MS = 1_800_000;

const STAR_RE = /VERDICT:[^\n]*?★\s*([0-5](?:\.\d)?)/;
const STAR_FALLBACK_RE = /VERDICT:[^\n]*?([0-5](?:\.\d)?)\s*\/\s*5/;

// 2026-09-20 (#132/#1027 秒死不可诊)：路由此前只留布尔判定，worker 的死因文本
// 随流关闭一起丢了 —— NDJSON 流不落盘，job-*.md 里只剩一句通用 reason。每个
// worker 的 stderr 尾部滚动保留这么长，失败项随 ⚠️ 行进 run 产物。
const STDERR_TAIL_CHARS = 400;

type Target = { n: string; company: string };
type CheckupOutcome = {
  cleanExit: boolean;
  sawError: boolean;
  persisted: boolean;
  timedOut: boolean;
  star: number | null;
  errMsg: string | null;
  cancelled: boolean;
  /** Rolling tail of the worker's stderr (whitespace-collapsed), or null. */
  stderrTail: string | null;
  /** ADR-0046: real execution start (ms) once the worker spawned; 0 if never spawned. */
  startedMs: number;
};

export async function POST(req: Request) {
  let body: { ns?: unknown; cliId?: unknown; model?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const ns = Array.isArray(body.ns)
    ? [...new Set(body.ns.filter((n): n is string => typeof n === "string" && /^\d+$/.test(n.trim())).map((n) => n.trim()))]
    : [];
  if (ns.length === 0) {
    return new Response(JSON.stringify({ error: "at least one tracker row number required" }), { status: 400 });
  }
  if (ns.length > MAX_ITEMS) {
    return new Response(JSON.stringify({ error: `too many rows (max ${MAX_ITEMS} per batch)` }), { status: 400 });
  }
  const cliId = typeof body.cliId === "string" ? body.cliId : "";
  const model = typeof body.model === "string" ? body.model : "";
  const resolved = cliId ? resolveCli(cliId) : null;
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;
  const root = careerOpsRoot();
  // The checkup engine lives in the user layer's Custom Workflows — same
  // completeness gate as /api/run's kind:"checkup".
  if (!fs.existsSync(path.join(root, "modes", "_custom.md"))) {
    return new Response(
      JSON.stringify({
        error: "This needs a complete career-ops checkout (modes/_custom.md). CAREER_OPS_ROOT has data only — point it at a full checkout.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  // ADR-0035: resolve every target company at DISPATCH (the same resolver the
  // single checkup path uses) so the worker never re-derives it from the
  // tracker. Rows that don't resolve are failed items up front — they never
  // spawn a worker (ADR-0041 决议 5 的对偶：resolvable 才进批量).
  const resolvable: Target[] = [];
  const unresolvable: { n: string; reason: string }[] = [];
  for (const n of ns) {
    const t = findCheckupTarget(n);
    if (t.ok) resolvable.push({ n, company: t.company });
    else
      unresolvable.push({
        n,
        reason:
          t.reason === "row-not-found"
            ? "no tracker row for this report number"
            : "unknown-employer row has no Via company to check up on",
      });
  }
  // ADR-0041 决议 5: a row with a checkup ALREADY RUNNING is skipped
  // (`skipped-running`), never auto-replaced — the batch must not make the
  // ADR-0033 stop/replace call on the user's behalf. Checked here, once, at
  // dispatch; a conflict that appears during the batch (check-vs-spawn gap) is
  // covered by the per-item ledger gate — a double-run adds rows for the same
  // tracker# and the diff still proves persistence, so no row is lost.
  const targets: Target[] = [];
  const skippedRunning: { n: string; company: string }[] = [];
  for (const t of resolvable) {
    const verdict = decideBatchCheckupConflict({ live: listLiveCheckups(t.n) });
    if (verdict.action === "dispatch") targets.push(t);
    else skippedRunning.push(t);
  }

  const checkupLedgerPath = path.join(root, "data", "company-checkups.tsv");
  const readCheckupLedger = (): string | undefined => {
    try {
      return fs.readFileSync(checkupLedgerPath, "utf8");
    } catch {
      return undefined;
    }
  };
  const htmlExists = makeCheckupHtmlProbe(root);
  const artifactRowsFor = (n: string) => checkupArtifactRowCountForTracker(readCheckupLedger(), n, htmlExists);

  let cancelled = false;
  // ADR-0042 决议 6：服务端逐项登记的键（同 batch-evaluate）。
  const batchId = randomUUID();
  // ADR-0045 决议 2/5：终态即落台账（done/error/cancel 都写），ledgerEnd 随终结
  // 分支更新；默认保守判 error（未走到任何终态分支就被 finally 收场）。
  const runStartedAt = Date.now();
  const ledgerEnd: { status: "done" | "error"; msg?: string } = { status: "error", msg: "batch ended before a final status was reported" };
  const children = new Set<ReturnType<typeof spawnHeadlessCli>>();
  // Every dispatched worker holds a global-pool handle; on batch cancel we
  // dequeue the ones still waiting for a slot so they never spawn.
  const poolHandles = new Set<PoolHandle>();
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (ev: Record<string, unknown>) => {
        if (closed) return;
        controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
      };
      const heartbeat = setInterval(() => send({ type: "keepalive" }), 10_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      let ok = 0;
      let failed = 0;
      let skipped = 0; // target-resolution failures — reported, never spawned

      try {
        // ADR-0042 决议 6：首个事件宣告 batchId 并登记逐项真相源（同 batch-evaluate）。
        send({ type: "open", batchId, kind: "batch-checkup", total: ns.length });
        registerBatchRun(batchId, { kind: "batch-checkup", total: ns.length });
        // Report the unresolvable rows as failed items before any worker starts,
        // so the per-item清单 the card renders accounts for EVERY selected row.
        for (const u of unresolvable) {
          skipped++;
          failed++;
          send({ type: "item", n: u.n, company: null, ok: false, star: null, reason: u.reason });
          send({ type: "text", text: `\u26A0\uFE0F not checkable: #${u.n} — ${u.reason}\n` });
          recordBatchItem(batchId, { key: u.n, label: `#${u.n}`, ok: false, skipped: false, reason: u.reason });
        }
        // Same for already-running rows — annotated, never spawned, never
        // counted as failures (ADR-0041 决议 5: skipping is the batch's
        // conflict answer, not an error).
        for (const s of skippedRunning) {
          send({
            type: "item",
            n: s.n,
            company: s.company,
            ok: false,
            star: null,
            reason: "skipped-running: a checkup for this row is already in flight — stop or replace it from the report page first",
          });
          send({ type: "text", text: `\u23F8 skipped (already running): #${s.n} ${s.company}\n` });
          // skipped-running 单列、不算失败（ADR-0041 决议 5 的登记表侧对齐）。
          recordBatchItem(batchId, { key: s.n, label: `#${s.n} ${s.company}`, ok: false, skipped: true, reason: "skipped-running" });
        }

        // Check up one tracker row with its pre-resolved company. Parallel-safe by
        // construction: the worker owns tracker# n (HTML filename, ledger key, and
        // its own evaluation report for the appendix), so no two workers touch the
        // same file. The item gate is the per-tracker# ledger DIFF — snapshotted
        // right before spawn so concurrent workers writing other keys never leak
        // into it.
        const checkupOne = (t: Target) =>
          new Promise<CheckupOutcome>((resolve) => {
            let sawError = false;
            let star: number | null = null;
            let timedOut = false;
            const poolHandle = acquire({ url: `#${t.n}`, title: t.company, reportNum: Number(t.n), source: "batch", cliId, model: model || undefined });
            poolHandles.add(poolHandle);
            const prompt = buildPrompt({
              kind: "checkup",
              input: t.n,
              memory: readMemory(),
              today,
              checkupCompany: t.company,
            });
            // Plain-text argv (spec.args), not streamArgs — same reading mode as
            // batch-evaluate. Tool policy comes from claude-invocation.mjs (checkup
            // is a PERSISTING kind there): without it a headless `claude -p` runs on
            // default permissions and dead-ends on the first Bash approval (the
            // 2026-09-15 batch outage). Non-claude engines get no tool flags — the
            // known per-CLI authorization gap (#2507), unchanged by this route.
            const args = withModelFlag(
              spec.id === "claude"
                ? [...spec.args(prompt), ...permissionFlags("checkup")]
                : spec.args(prompt),
              spec.model,
              model,
            );
            const finish = (outcome: CheckupOutcome) => {
              poolHandles.delete(poolHandle);
              release(poolHandle.id);
              resolve(outcome);
            };
            const plain = (extra: Partial<CheckupOutcome>): CheckupOutcome => ({
              cleanExit: false,
              sawError: true,
              persisted: false,
              timedOut: false,
              star: null,
              errMsg: null,
              cancelled: false,
              stderrTail: null,
              startedMs: 0,
              ...extra,
            });
            void (async () => {
              const started = await poolHandle.ready;
              if (!started) {
                finish(plain({ cancelled: true }));
                return;
              }
              const rowsBefore = artifactRowsFor(t.n);
              const startedMs = Date.now();
              const child = spawnHeadlessCli(binPath, args, { cwd: root, env: process.env });
              children.add(child);
              const killer = setTimeout(() => {
                timedOut = true;
                terminateCli(child);
              }, CHECKUP_WORKER_KILL_MS);
              child.stdout?.setEncoding("utf-8");
              child.stderr?.setEncoding("utf-8");
              child.stdout?.on("data", (chunk: string) => {
                const sm = chunk.match(STAR_RE) ?? chunk.match(STAR_FALLBACK_RE);
                if (sm) star = parseFloat(sm[1]);
              });
              // Per-line stderr classification (same discipline as batch-evaluate):
              // claude/opencode stream progress telemetry to stderr — a bare word
              // match would flag clean runs as failures.
              const isFatalStderr = spec.stderrIsFatal ?? isFatalGenericStderr;
              let stderrBuf = "";
              let stderrTail = "";
              const flagStderrLine = (line: string) => {
                if (line.trim() && isFatalStderr(line)) sawError = true;
              };
              child.stderr?.on("data", (chunk: string) => {
                stderrBuf += chunk;
                stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
                let nl;
                while ((nl = stderrBuf.indexOf("\n")) !== -1) {
                  const line = stderrBuf.slice(0, nl);
                  stderrBuf = stderrBuf.slice(nl + 1);
                  flagStderrLine(line);
                }
              });
              const tailOf = (): string | null => {
                // stderrTail 在所有 data chunk 里滚动，未消费的行尾也已包含；
                // 不叠加 stderrBuf，避免 error 路径（尾行未消费）重复同一段字节。
                const t = stderrTail.replace(/\s+/g, " ").trim();
                return t ? t.slice(-STDERR_TAIL_CHARS) : null;
              };
              child.on("error", (err) => {
                sawError = true;
                clearTimeout(killer);
                send({ type: "text", text: `\u274C #${t.n} ${t.company}: ${err.message}\n` });
                finish(plain({ errMsg: err.message.slice(0, 200), star, stderrTail: tailOf() }));
                children.delete(child);
              });
              child.on("close", (code) => {
                clearTimeout(killer);
                if (stderrBuf) {
                  flagStderrLine(stderrBuf);
                  stderrBuf = "";
                }
                const cleanExit = code === 0;
                const persisted = artifactRowsFor(t.n) > rowsBefore;
                finish({
                  cleanExit,
                  sawError,
                  persisted,
                  timedOut,
                  star,
                  errMsg: timedOut ? `checkup worker exceeded its ${CHECKUP_WORKER_KILL_MS / 60_000}-minute cap and was killed` : null,
                  cancelled: false,
                  stderrTail: tailOf(),
                  startedMs,
                });
                children.delete(child);
              });
            })();
          });

        // Bounded parallel pool — same pump shape as batch-evaluate.
        const poolLimit = Math.min(MAX_PARALLEL, targets.length);
        let cursor = 0;
        let active = 0;
        await new Promise<void>((poolDone) => {
          const pump = () => {
            if (cancelled) {
              if (active === 0) poolDone();
              return;
            }
            while (cursor < targets.length && active < poolLimit) {
              const t = targets[cursor++];
              active++;
              send({ type: "status", label: `[${cursor}/${targets.length}] #${t.n} ${t.company}` });
              checkupOne(t)
                .then((outcome) => {
                  const itemOk = outcome.persisted && outcome.cleanExit && !outcome.sawError && !outcome.cancelled;
                  if (itemOk) ok++;
                  else failed++;
                  // reason 判定链只算一次，NDJSON item 事件与服务端登记表共用
                  // （评审修复：两条通道的失败原因必须一致，登记表不得比实时流
                  // 少兜底文案）。
                  const reason = itemOk
                    ? undefined
                    : outcome.cancelled
                      ? "cancelled"
                      : outcome.timedOut
                        ? `checkup worker exceeded its ${CHECKUP_WORKER_KILL_MS / 60_000}-minute cap`
                        : outcome.errMsg
                          ? outcome.errMsg.slice(0, 200)
                          : !outcome.cleanExit || outcome.sawError
                            ? "the run hit an error before finishing — re-run it to verify"
                            : "the worker ran but never added a checkup ledger row";
                  // ADR-0046：子项计时（成功项才有真实起点），供卡片「时长」与子台账行同值。
                  const itemEndedMs = Date.now();
                  const itemStartedMs = itemOk && outcome.startedMs ? outcome.startedMs : undefined;
                  send({
                    type: "item",
                    n: t.n,
                    company: t.company,
                    ok: itemOk,
                    star: itemOk ? outcome.star : null,
                    startedAt: itemStartedMs,
                    finishedAt: itemStartedMs != null ? itemEndedMs : undefined,
                    reason,
                  });
                  send({
                    type: "text",
                    text: itemOk
                      ? `\u2705 done: #${t.n} ${t.company}${outcome.star != null ? ` — \u2605${outcome.star}/5` : ""}\n`
                      : outcome.cancelled
                        ? `\u2391 cancelled: #${t.n} ${t.company}\n`
                        : // 失败项把 stderr 尾部一并落进 run 产物（text 事件进 job-*.md 的
                          // Output 段）—— 2026-09-20 #132/#1027 秒死后无从查死因。
                          `\u26A0\uFE0F NOT recorded: #${t.n} ${t.company}` +
                          (outcome.stderrTail ? `\n\u2139\uFE0F stderr tail: ${outcome.stderrTail}\n` : "\n"),
                  });
                  // ADR-0042 决议 6：逐项结论同步入服务端登记表（幂等，事件乱序安全）。
                  recordBatchItem(batchId, {
                    key: t.n,
                    label: `#${t.n} ${t.company}`,
                    ok: itemOk,
                    skipped: false,
                    star: itemOk ? outcome.star : null,
                    startedAt: itemStartedMs,
                    finishedAt: itemStartedMs != null ? itemEndedMs : undefined,
                    reason,
                    // 秒死不可诊 #132/#1027：失败项的 stderr 尾部随逐项快照落台账，
                    // 不再只活在流过即逝的 NDJSON text 事件里。
                    stderrTail: itemOk ? undefined : outcome.stderrTail ?? undefined,
                  });
                  // ADR-0046：成功子项即时写一条独立子台账行（以 tracker# 为报告键），
                  // 使其能被 /jobs/[id] 当独立工作器打开。fire-and-forget，失败不反噬 run。
                  if (itemOk) {
                    try {
                      appendRunRecord(root, buildBatchChildRecord({
                        batchId,
                        childKind: "batch-checkup-item",
                        key: t.n,
                        label: `#${t.n} ${t.company}`,
                        startedAt: outcome.startedMs || runStartedAt,
                        finishedAt: itemEndedMs,
                        cliId,
                        model,
                        trackerN: t.n,
                      }));
                    } catch (e) {
                      console.error("[run-ledger] batch child append failed:", e instanceof Error ? e.message : e);
                    }
                  }
                })
                .catch(() => failed++)
                .finally(() => {
                  active--;
                  pump();
                });
            }
            if (cursor >= targets.length && active === 0) poolDone();
          };
          pump();
        });

        if (cancelled) {
          const cancelMsg = "Batch cancelled. Anything already written stays (the checkup ledger only appends).";
          send({ type: "error", msg: cancelMsg, startedAt: runStartedAt, finishedAt: Date.now() });
          ledgerEnd.status = "error";
          ledgerEnd.msg = cancelMsg;
        } else {
          // Honesty gate (ADR-0041 决议 6): a batch where NOTHING was persisted is
          // a failed batch, not a green card — pure function, tested in
          // batch-checkup-gate.test.mjs.
          const finalEv = batchCheckupFinalEvent({
            ok,
            failed,
            skipped,
            skippedRunning: skippedRunning.length,
            startedAt: runStartedAt,
            finishedAt: Date.now(),
          });
          send(finalEv);
          ledgerEnd.status = finalEv.type === "done" ? "done" : "error";
          ledgerEnd.msg = finalEv.type === "done" ? undefined : finalEv.msg;
        }
      } catch (err) {
        send({ type: "error", msg: (err as Error).message, startedAt: runStartedAt, finishedAt: Date.now() });
        ledgerEnd.status = "error";
        ledgerEnd.msg = (err as Error).message;
      } finally {
        // ADR-0042 决议 6：批量终态，登记表条目转为淘汰候选。
        completeBatchRun(batchId);
        // ADR-0045 决议 2/5：终态即落台账，内嵌已完成部分的逐项快照。
        // fire-and-forget，与 /api/run 的 recordEnd 同纪律：台账失败绝不反噬 run。
        try {
          appendRunRecord(root, buildBatchLedgerRecord({
            batchId,
            kind: "batch-checkup",
            title: `批量体检 · ${ns.length} 项`,
            input: ns.length === 1 ? `#${ns[0]}` : `#${ns[0]} +${ns.length - 1}`,
            startedAt: runStartedAt,
            total: ns.length,
            status: ledgerEnd.status,
            msg: ledgerEnd.msg,
            cliId,
            model,
            items: getBatchItems(batchId) ?? [],
          }));
        } catch (e) {
          console.error("[run-ledger] batch append failed:", e instanceof Error ? e.message : e);
        }
        close();
      }
    },
    cancel() {
      cancelled = true;
      // SIGTERM each in-flight worker (whole process tree — terminateCli);
      // the pump checks `cancelled` and dispatches nothing more.
      for (const child of children) {
        terminateCli(child);
      }
      children.clear();
      // Queued workers never spawned — dequeue them so their pool-ready
      // resolves false and they never spawn (ADR-0014 Q5 dequeue path).
      for (const h of poolHandles) {
        h.cancel();
      }
      poolHandles.clear();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
