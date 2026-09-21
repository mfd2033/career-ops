// Batch evaluate — the pipeline page's "re-evaluate N selected" path.
//
// Runs the SAME engine as single evaluation (/api/run): the CLI + model picked
// on the config page, the same evaluate prompt per URL, the same honesty gate
// (green requires a clean exit AND a report actually written). Where it differs
// is ORCHESTRATION, and that is exactly what lets it run in PARALLEL where a
// row of single-evaluate cards cannot:
//
//   The single evaluate prompt (buildPrompt) tells each worker to reserve its
//   OWN report number and merge the tracker ITSELF. N concurrent workers doing
//   that on the same files races both — which is why /api/run serializes. This
//   route instead reserves a CONTIGUOUS RANGE up front
//   (reserve-report-num.mjs --count N), hands each worker its own number via
//   buildBatchPrompt, and tells it NOT to merge. Each worker then writes only
//   ITS OWN reports/{num}-*.md and batch/tracker-additions/{num}-*.tsv — no
//   shared mutable state, so concurrency is safe by construction. When every
//   worker is done, the orchestrator runs merge-tracker.mjs ONCE to fold all
//   rows into data/applications.md, then releases the whole reserved range.
//
// Streams NDJSON events the client job runner parses:
// {type:"status"|"text"|"item"|"done"|"error"|"keepalive"} — "item" per URL.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { registerBatchRun, recordBatchItem, completeBatchRun, getBatchItems } from "@/lib/batch-items.mjs";
import { appendRunRecord } from "@/lib/run-ledger.mjs";
import { buildBatchLedgerRecord } from "@/lib/batch-ledger.mjs";
import { resolveCli } from "@/lib/clis";
import { withModelFlag, isFatalGenericStderr, parseReservationOutput } from "@/lib/run-cli-support.mjs";
import { permissionFlags } from "@/lib/claude-invocation.mjs";
import { isReservedReportFile } from "@/lib/report-files.mjs";
import { spawnHeadlessCli, terminateCli } from "@/lib/spawn-cli.mjs";
import { careerOpsRoot, readMemory, readInbox, readScanDates } from "@/lib/career-ops";
import { readAppConfig } from "@/lib/app-config";
import { buildBatchPrompt } from "@/lib/run-prompts.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { acquire, release, __setSizeSource, DEFAULT_POOL_SIZE, type PoolHandle } from "@/lib/core/concurrency-pool";

// Feed the global concurrency pool the live configured size (app-config), re-read
// on every dispatch so a config-page edit takes effect without restart.
__setSizeSource(() => readAppConfig().concurrencyPool ?? DEFAULT_POOL_SIZE);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const MAX_URLS = 20;
const MAX_PARALLEL = 3; // bounded worker pool; batch-runner.sh uses 1, this stays modest

const execFileAsync = promisify(execFile);

export async function POST(req: Request) {
  let body: { urls?: unknown; cliId?: unknown; model?: unknown; jdText?: unknown; company?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const urls = Array.isArray(body.urls)
    ? body.urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u.trim())).map((u) => u.trim())
    : [];
  if (urls.length === 0) {
    return new Response(JSON.stringify({ error: "at least one http(s) URL required" }), { status: 400 });
  }
  if (urls.length > MAX_URLS) {
    return new Response(JSON.stringify({ error: `too many URLs (max ${MAX_URLS} per batch)` }), { status: 400 });
  }
  // 内联 JD 文本(浏览器扩展 DOM 提取,绕过登录墙):只对单 URL 评估有意义 —
  // 一条 jdText 对应一个职位,多 URL 混用会让其余 worker 的提示错位。
  const jdText = typeof body.jdText === "string" ? body.jdText : "";
  if (jdText.trim() && urls.length !== 1) {
    return new Response(JSON.stringify({ error: "jdText is only valid with exactly one URL" }), { status: 400 });
  }
  const company = typeof body.company === "string" ? body.company : "";
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
  // Same completeness + CV gates as /api/run's evaluate kind.
  for (const f of ["modes/oferta.md", "cv.md"]) {
    if (!fs.existsSync(path.join(root, f))) {
      return new Response(
        JSON.stringify({
          error: `This needs a complete career-ops checkout (${f}). CAREER_OPS_ROOT has data only — point it at a full checkout.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const inboxPostedAt = new Map(readInbox().filter((j) => j.url).map((j) => [j.url as string, j.postedAt]));
  const scanDates = readScanDates();
  const reportsDir = path.join(root, "reports");
  const reportEntries = () => {
    try {
      return fs.readdirSync(reportsDir);
    } catch {
      return [];
    }
  };
  const runNode = (script: string, args: string[]) =>
    execFileAsync(process.execPath, [path.join(root, script), ...args], { cwd: root });

  // promisify(execFile) resolves { stdout, stderr } on Node builds that set
  // customPromisifyArgs on execFile, but on others (some v22.x) it resolves
  // the stdout string itself — destructuring `{ stdout }` from that yields
  // undefined, and a `.trim()` on it crashes with "Cannot read properties of
  // undefined (reading 'trim')". Normalize both shapes to the text.
  const runNodeText = (out: unknown): string => {
    if (typeof out === "string") return out;
    if (out && typeof out === "object" && typeof (out as { stdout?: unknown }).stdout === "string") {
      return (out as { stdout: string }).stdout;
    }
    return "";
  };

  // --- Reserve a contiguous report-number range up front -----------------------
  // Parallel workers must NEVER compute max+1 themselves (#749); the range is
  // the single point of allocation. Each URL gets its own number in order.
  let reserved: number[] = [];
  const reserveRange = async () => {
    const stdout = runNodeText(await runNode("reserve-report-num.mjs", ["--count", String(urls.length)]));
    // parseReservationOutput (tested in tests/reservation-output-parse.test.mjs)
    // accepts 3+ digits: the allocator keeps emitting ranges past #999
    // (formatReportNumber pads, never truncates), and the old inline \d{3}
    // regex made every batch die there once reports crossed #999.
    const parsed = parseReservationOutput(stdout);
    if (!parsed) throw new Error(`unexpected reservation output: ${stdout.trim()}`);
    reserved = parsed;
    if (reserved.length !== urls.length) throw new Error(`reserved ${reserved.length} but needed ${urls.length}`);
  };

  // Did THIS worker's own number get a real (non-sentinel) report? Parallel-safe:
  // each worker owns {num}, so a match keyed on the number proves that worker
  // persisted — no cross-worker interference, unlike a global before/after diff.
  const wroteReportForNum = (num: number) => {
    const prefix = String(num).padStart(3, "0") + "-";
    return reportEntries().some((n) => n.startsWith(prefix) && n.endsWith(".md") && !isReservedReportFile(n));
  };

  // Remove this batch's reservation sentinels (reports/{NNN}-RESERVED.md).
  // Called from BOTH the normal completion path and the client-cancel path —
  // the CLI --release path runs with force:true, so it needs no ownership token.
  // Best-effort: a failure only leaves sentinels to the stale GC, never breaks
  // the batch's own outcome events.
  const releaseReserved = async () => {
    if (reserved.length === 0) return;
    try {
      await runNode("reserve-report-num.mjs", [
        "--release",
        `${reserved[0].toString().padStart(3, "0")}-${reserved[reserved.length - 1].toString().padStart(3, "0")}`,
      ]);
    } catch {
      /* release is best-effort; stale GC is the fallback */
    }
  };

  let cancelled = false;
  // ADR-0042 决议 6：服务端逐项登记的键。open 事件把它交给客户端（跨页签恢复
  // 清单用），扩展端忽略未知事件类型不受影响。
  const batchId = randomUUID();
  // ADR-0045 决议 2/5：终态即落台账（done/error/cancel 都写）——startedAt 在
  // 派发前取，ledgerEnd 随终结分支更新（默认保守判 error：没走到任何终态分支
  // 就被 finally 收场的 run 不是成功）。
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

      // Tracker-mutating (the final merge folds rows into applications.md), so a
      // concurrent tracker.mjs delete must not race it. One token for the batch.
      const writeToken = acquireTrackerWrite();
      let ok = 0;
      let failed = 0;
      // Successfully-evaluated (report number, URL) pairs, folded into the
      // tracker by mergeTrackerRows below AND moved out of pipeline.md's
      // Pendientes by reconcilePipelineRows — without the latter, every JD
      // evaluated from the web inbox kept its `- [ ]` row and re-surfaced in
      // Pendientes on the next refresh (the "evaluated JDs came back to the
      // inbox" bug: the web path never wrote pipeline.md at all).
      const okEntries: { num: number; url: string }[] = [];

      try {
        // ADR-0042 决议 6：首个事件宣告 batchId 并登记逐项真相源——之后每个 item
        // 事件同步写入登记表，GET /api/batch-items 供其他页签/丢失累积的详情页恢复。
        send({ type: "open", batchId, kind: "batch-evaluate", total: urls.length });
        registerBatchRun(batchId, { kind: "batch-evaluate", total: urls.length });
        await reserveRange();

        // Evaluate one URL with a pre-reserved, exclusively-owned report number.
        // Each batch worker needs its OWN global-pool slot before it spawns, so
        // batch-internal MAX_PARALLEL converges into the global cap (ADR-0014
        // Q1/Q7): report numbers are still handed out in array order regardless
        // of which worker grabs a slot first. A worker dequeued while queued is
        // counted `cancelled` and never spawns.
        const evaluateOne = (i: number, num: number) =>
          new Promise<{ cleanExit: boolean; sawError: boolean; verdict: string | null; errMsg: string | null; cancelled: boolean }>((resolve) => {
            let sawError = false;
            let verdict: string | null = null;
            // 代理显式输出的错误行(如登录墙 `ERROR: cannot extract JD ...`)。
            // 用于让 pipeline 卡片显示真实失败原因,而非误导性的通用双消息。
            let errMsg: string | null = null;
            const url = urls[i];
            const poolHandle = acquire({ url, title: url, reportNum: num, source: "batch", cliId, model: model || undefined });
            poolHandles.add(poolHandle);
            const postedAt = inboxPostedAt.get(url) ?? scanDates.get(url);
            // 内联 JD/雇主名只对唯一 URL(扩展详情页单评估)有意义;多 URL 时
            // 上面的 400 已拦截,这里无需按 i 区分。
            const prompt = buildBatchPrompt(String(num).padStart(3, "0"), {
              input: url,
              memory: readMemory(),
              today,
              postedAt,
              unknownEmployer: readAppConfig().unknownEmployer,
              jdText: jdText.trim() || undefined,
              company: company.trim() || undefined,
            });
            // Plain-text argv (spec.args), not streamArgs: the batch route reads
            // the agent's output as text and extracts the VERDICT line — per-event
            // parsing is /api/run's single-run concern.
            // Tool policy comes from claude-invocation.mjs (the NO-RUNTIME-GRANTS
            // rule in clis.ts) — never spelled here. Without it a headless
            // `claude -p` runs on default permissions: Bash needs approval, so the
            // FIRST browser-extract call (Chinese boards serve JDs behind a login
            // wall) dead-ends on "This command requires approval" and the worker
            // exits without writing anything (2026-09-15: 80 workers, ~77 min,
            // zero reports — the batch card still went green, see the done gate).
            // Batch reads plain text, not stream-json, so claudeCliArgs can't be
            // reused wholesale — only its permission tail.
            const args = withModelFlag(
              spec.id === "claude"
                ? [...spec.args(prompt), ...permissionFlags("evaluate")]
                : spec.args(prompt),
              spec.model,
              model,
            );
            const finish = (outcome: { cleanExit: boolean; sawError: boolean; verdict: string | null; errMsg: string | null; cancelled?: boolean }) => {
              poolHandles.delete(poolHandle);
              release(poolHandle.id);
              resolve(outcome as { cleanExit: boolean; sawError: boolean; verdict: string | null; errMsg: string | null; cancelled: boolean });
            };
            // Queue in the global pool; spawn only once a slot is granted. If the
            // task is dequeued (queued-cancel) while waiting, grant=false → skip.
            void (async () => {
              const started = await poolHandle.ready;
              if (!started) {
                finish({ cleanExit: false, sawError: true, verdict: null, errMsg: null, cancelled: true });
                return;
              }
              const child = spawnHeadlessCli(binPath, args, { cwd: root, env: process.env });
              children.add(child);
              child.stdout?.setEncoding("utf-8");
              child.stderr?.setEncoding("utf-8");
              child.stdout?.on("data", (chunk: string) => {
                const vm = chunk.match(/VERDICT:[^\n]*/i);
                if (vm) verdict = vm[0];
                // 捕捉显式错误行;多行时保留最后一条(最贴近失败处)。
                const em = chunk.match(/ERROR:[^\n]*/i);
                if (em) errMsg = em[0];
              });
              // 逐行分类 stderr,而非裸嗅探 "error|fatal":openCode/Claude 会把进度
              // 遥测(横幅、模型行、MCP 透传)写到 stderr,裸词会误判干净运行为失败 —
              // 与 /api/run 同一套 per-CLI 分类器(spec.stderrIsFatal,回退 generic)。
              // 分块可能切在词中间,先按行缓冲再分类;关闭时冲刷残留行。
              const isFatalStderr = spec.stderrIsFatal ?? isFatalGenericStderr;
              let stderrBuf = "";
              const flagStderrLine = (line: string) => {
                if (line.trim() && isFatalStderr(line)) sawError = true;
              };
              child.stderr?.on("data", (chunk: string) => {
                stderrBuf += chunk;
                let nl;
                while ((nl = stderrBuf.indexOf("\n")) !== -1) {
                  const line = stderrBuf.slice(0, nl);
                  stderrBuf = stderrBuf.slice(nl + 1);
                  flagStderrLine(line);
                }
              });
              child.on("error", (err) => {
                sawError = true;
                send({ type: "text", text: `\u274C ${url}: ${err.message}\n` });
                finish({ cleanExit: false, sawError: true, verdict: null, errMsg });
              });
              child.on("close", (code) => {
                if (stderrBuf) {
                  flagStderrLine(stderrBuf);
                  stderrBuf = "";
                }
                finish({ cleanExit: code === 0, sawError, verdict, errMsg });
                children.delete(child);
              });
            })();
          });
        // Bounded parallel pool. Each worker owns its number and its own report +
        // TSV files, so there is no shared state to serialize on — the pool just
        // caps how many heavyweight agent CLIs run at once.
        const poolLimit = Math.min(MAX_PARALLEL, urls.length);
        let cursor = 0;
        let active = 0;
        await new Promise<void>((poolDone) => {
          const pump = () => {
            if (cancelled) {
              if (active === 0) poolDone();
              return;
            }
            while (cursor < urls.length && active < poolLimit) {
              const i = cursor++;
              const num = reserved[i];
              active++;
              send({ type: "status", label: `[${i + 1}/${urls.length}] ${urls[i]} (report #${num})` });
              evaluateOne(i, num)
                .then((outcome) => {
                  const itemOk = outcome.cleanExit && !outcome.sawError && wroteReportForNum(num);
                  if (itemOk) {
                    ok++;
                    okEntries.push({ num, url: urls[i] });
                  }
                  else failed++;
                  // reason 判定链只算一次，NDJSON item 事件与服务端登记表共用
                  // （评审修复：两条通道的失败原因必须一致，恢复清单不得比实时
                  // 流少兜底文案）。
                  const score = itemOk && outcome.verdict
                    ? parseFloat((outcome.verdict.match(/([0-5](?:\.\d)?)/) ?? [])[1] ?? "") || null
                    : null;
                  const reason = itemOk
                    ? undefined
                    : outcome.cancelled
                      ? "cancelled"
                      : outcome.errMsg
                        ? outcome.errMsg.slice(0, 200)
                        : !outcome.cleanExit || outcome.sawError
                          ? "the run hit an error before finishing — re-run it to verify"
                          : "the worker ran but never saved a report/tracker row";
                  send({
                    type: "item",
                    url: urls[i],
                    ok: itemOk,
                    score,
                    // ADR-0046：成功项把预分配报告号透出，供卡片跳 /report/{num}（失败无报告不带）。
                    reportNum: itemOk ? num : undefined,
                    reason,
                  });
                  // ADR-0042 决议 6：逐项结论同步入服务端登记表（幂等，事件乱序安全）。
                  recordBatchItem(batchId, {
                    key: urls[i],
                    label: urls[i],
                    ok: itemOk,
                    skipped: false,
                    score,
                    reportNum: itemOk ? num : undefined,
                    reason,
                  });
                  send({
                    type: "text",
                    text: itemOk
                      ? `\u2705 [${i + 1}/${urls.length}] done: ${urls[i]}${outcome.verdict ? ` — ${outcome.verdict}` : ""}\n`
                      : outcome.cancelled
                        ? `\u2391 [${i + 1}/${urls.length}] cancelled: ${urls[i]}\n`
                        : `\u26A0\uFE0F [${i + 1}/${urls.length}] NOT recorded: ${urls[i]}\n`,
                  });
                })
                .catch(() => failed++)
                .finally(() => {
                  active--;
                  pump();
                });
            }
            if (cursor >= urls.length && active === 0) poolDone();
          };
          pump();
        });
        // Fold all tracker-additions rows into data/applications.md ONCE.
        // merge-tracker takes the core tracker lock itself, so this is the only
        // writer of applications.md for this batch — workers never touched it.
        // Runs in BOTH branches, cancelled or not: workers may have completed
        // and written valid reports+TSVs before a client disconnect, and
        // leaving those rows out of the tracker would silently lose a finished
        // re-evaluation (the user's "date column didn't change" after a web
        // re-eval was exactly this — reports written, merge never ran).
        const mergeTrackerRows = async () => {
          send({ type: "status", label: "Merging tracker rows..." });
          try {
            const stdout = runNodeText(await runNode("merge-tracker.mjs", []));
            if (stdout.trim()) send({ type: "text", text: `${stdout.trim()}\n` });
          } catch (err) {
            send({ type: "text", text: `\u26A0\uFE0F merge-tracker: ${(err as Error).message}\n` });
          }
        };
        // Move the batch's successfully-evaluated rows out of pipeline.md's
        // Pendientes (into Procesadas, with their report links). Best-effort:
        // a failure only means those rows stay in the inbox for a later pass —
        // the tracker merge above has already recorded them, so this must
        // never fail the batch or misreport a finished evaluation.
        const reconcilePipelineRows = async () => {
          if (okEntries.length === 0) return;
          send({ type: "status", label: "Reconciling pipeline.md..." });
          try {
            const stdout = runNodeText(
              await runNode("reconcile-pipeline.mjs", okEntries.flatMap((e) => ["--entry", `${e.num}|${e.url}`])),
            );
            if (stdout.trim()) send({ type: "text", text: `${stdout.trim()}\n` });
          } catch (err) {
            send({ type: "text", text: `\u26A0\uFE0F reconcile-pipeline: ${(err as Error).message}\n` });
          }
        };
        if (cancelled) {
          // Client dropped the connection mid-batch: still fold whatever the
          // workers finished, then release the reserved range so the numbers
          // are not held hostage until the stale GC.
          await mergeTrackerRows();
          await reconcilePipelineRows();
          await releaseReserved();
          send({ type: "error", msg: "Batch cancelled." });
          ledgerEnd.status = "error";
          ledgerEnd.msg = "Batch cancelled.";
        } else {
          await mergeTrackerRows();
          await reconcilePipelineRows();
          // Clean up reservation sentinels — completed slots already hold real
          // reports, so releasing the range only removes leftover placeholders.
          await releaseReserved();
          // Honesty gate, same discipline as /api/run's: a batch where NOTHING
          // was recorded is a failed batch, not a green card. The 2026-09-15
          // permission outage ended 80/80 workers with zero reports and this
          // still sent done — the card banked "done" and fired co-job-done
          // refreshes for data that did not exist.
          if (ok === 0 && failed > 0) {
            const allFailedMsg = `All ${failed} evaluation(s) failed — no reports or tracker rows were written. See the NOT recorded lines above for per-URL reasons.`;
            send({ type: "error", msg: allFailedMsg });
            ledgerEnd.status = "error";
            ledgerEnd.msg = allFailedMsg;
          } else {
            send({ type: "done", ok, failed });
            ledgerEnd.status = "done";
            ledgerEnd.msg = undefined;
          }
        }
      } catch (err) {
        // Anything after a successful reserveRange() that throws (e.g. send()
        // failing on a dropped stream) skips both the cancel and normal-completion
        // branches above, so release the reserved range here too — otherwise the
        // sentinels sit until the 4h stale GC. Best-effort, same as everywhere else.
        await releaseReserved();
        send({ type: "error", msg: (err as Error).message });
        ledgerEnd.status = "error";
        ledgerEnd.msg = (err as Error).message;
      } finally {
        // ADR-0042 决议 6：批量终态（含取消/异常），登记表条目转为淘汰候选。
        completeBatchRun(batchId);
        // ADR-0045 决议 2/5：终态即落台账，内嵌已完成部分的逐项快照。
        // fire-and-forget，与 /api/run 的 recordEnd 同纪律：台账失败绝不反噬 run。
        try {
          appendRunRecord(root, buildBatchLedgerRecord({
            batchId,
            kind: "batch-evaluate",
            title: `批量评估 · ${urls.length} 项`,
            input: urls.length === 1 ? urls[0] : `${urls[0]} +${urls.length - 1}`,
            startedAt: runStartedAt,
            total: urls.length,
            status: ledgerEnd.status,
            msg: ledgerEnd.msg,
            cliId,
            model,
            items: getBatchItems(batchId) ?? [],
          }));
        } catch (e) {
          console.error("[run-ledger] batch append failed:", e instanceof Error ? e.message : e);
        }
        releaseTrackerWrite(writeToken);
        close();
      }
    },
    cancel() {
      cancelled = true;
      // SIGTERM 每个 in-flight worker；pool pump 检查 `cancelled` 并停止
      // 分发更多。必须按进程树终止（terminateCli），否则 CLI 派生的子进程
      // 残留成孤儿。
      for (const child of children) {
        terminateCli(child);
      }
      children.clear();
      // 排队中的 worker 还未 spawn——dequeue 它们，让各自的 pool-ready 以 false
      // resolve，从而永不 spawn（ADR-0014 Q5 的 dequeue 路径）。
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