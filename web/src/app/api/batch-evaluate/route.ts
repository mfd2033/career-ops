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
import { resolveCli } from "@/lib/clis";
import { withModelFlag } from "@/lib/run-cli-support.mjs";
import { isReservedReportFile } from "@/lib/report-files.mjs";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { careerOpsRoot, readMemory, readInbox, readScanDates } from "@/lib/career-ops";
import { buildBatchPrompt } from "@/lib/run-prompts.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const MAX_URLS = 20;
const MAX_PARALLEL = 3; // bounded worker pool; batch-runner.sh uses 1, this stays modest

const execFileAsync = promisify(execFile);

export async function POST(req: Request) {
  let body: { urls?: unknown; cliId?: unknown; model?: unknown };
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

  // --- Reserve a contiguous report-number range up front -----------------------
  // Parallel workers must NEVER compute max+1 themselves (#749); the range is
  // the single point of allocation. Each URL gets its own number in order.
  let reserved: number[] = [];
  const reserveRange = async () => {
    const { stdout } = await runNode("reserve-report-num.mjs", ["--count", String(urls.length)]);
    const m = stdout.trim().match(/^(\d{3})(?:-(\d{3}))?$/);
    if (!m) throw new Error(`unexpected reservation output: ${stdout.trim()}`);
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    reserved = Array.from({ length: b - a + 1 }, (_, k) => a + k);
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
  const children = new Set<ReturnType<typeof spawnHeadlessCli>>();
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

      try {
        await reserveRange();

        // Evaluate one URL with a pre-reserved, exclusively-owned report number.
        const evaluateOne = (i: number, num: number) =>
          new Promise<{ cleanExit: boolean; sawError: boolean; verdict: string | null }>((resolve) => {
            let sawError = false;
            let verdict: string | null = null;
            const url = urls[i];
            const postedAt = inboxPostedAt.get(url) ?? scanDates.get(url);
            const prompt = buildBatchPrompt(String(num).padStart(3, "0"), {
              input: url,
              memory: readMemory(),
              today,
              postedAt,
            });
            // Plain-text argv (spec.args), not streamArgs: the batch route reads
            // the agent's output as text and extracts the VERDICT line — per-event
            // parsing is /api/run's single-run concern.
            const args = withModelFlag(spec.args(prompt), spec.model, model);
            const child = spawnHeadlessCli(binPath, args, { cwd: root, env: process.env });
            children.add(child);
            child.stdout?.setEncoding("utf-8");
            child.stderr?.setEncoding("utf-8");
            child.stdout?.on("data", (chunk: string) => {
              const vm = chunk.match(/VERDICT:[^\n]*/i);
              if (vm) verdict = vm[0];
            });
            child.stderr?.on("data", (chunk: string) => {
              if (/error|fatal/i.test(chunk)) sawError = true;
            });
            child.on("error", (err) => {
              sawError = true;
              send({ type: "text", text: `\u274C ${url}: ${err.message}\n` });
              resolve({ cleanExit: false, sawError: true, verdict: null });
            });
            child.on("close", (code) => {
              resolve({ cleanExit: code === 0, sawError, verdict });
              children.delete(child);
            });
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
                  if (itemOk) ok++;
                  else failed++;
                  send({
                    type: "item",
                    url: urls[i],
                    ok: itemOk,
                    score:
                      itemOk && outcome.verdict
                        ? parseFloat((outcome.verdict.match(/([0-5](?:\.\d)?)/) ?? [])[1] ?? "") || null
                        : null,
                    reason: itemOk
                      ? undefined
                      : !outcome.cleanExit || outcome.sawError
                        ? "the run hit an error before finishing — re-run it to verify"
                        : "the worker ran but never saved a report/tracker row",
                  });
                  send({
                    type: "text",
                    text: itemOk
                      ? `\u2705 [${i + 1}/${urls.length}] done: ${urls[i]}${outcome.verdict ? ` — ${outcome.verdict}` : ""}\n`
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
            const { stdout } = await runNode("merge-tracker.mjs", []);
            if (stdout.trim()) send({ type: "text", text: `${stdout.trim()}\n` });
          } catch (err) {
            send({ type: "text", text: `\u26A0\uFE0F merge-tracker: ${(err as Error).message}\n` });
          }
        };
        if (cancelled) {
          // Client dropped the connection mid-batch: still fold whatever the
          // workers finished, then release the reserved range so the numbers
          // are not held hostage until the stale GC.
          await mergeTrackerRows();
          await releaseReserved();
          send({ type: "error", msg: "Batch cancelled." });
        } else {
          await mergeTrackerRows();
          // Clean up reservation sentinels — completed slots already hold real
          // reports, so releasing the range only removes leftover placeholders.
          await releaseReserved();
          send({ type: "done", ok, failed });
        }
      } catch (err) {
        // Anything after a successful reserveRange() that throws (e.g. send()
        // failing on a dropped stream) skips both the cancel and normal-completion
        // branches above, so release the reserved range here too — otherwise the
        // sentinels sit until the 4h stale GC. Best-effort, same as everywhere else.
        await releaseReserved();
        send({ type: "error", msg: (err as Error).message });
      } finally {
        releaseTrackerWrite(writeToken);
        close();
      }
    },
    cancel() {
      cancelled = true;
      // SIGTERM every in-flight worker; the pool pump checks `cancelled` and
      // stops before dispatching more.
      for (const child of children) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      children.clear();
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