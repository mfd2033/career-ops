// Batch evaluate — the pipeline page's "re-evaluate N selected" path. Uses the
// EXACT same engine as single evaluation (/api/run): the CLI + model picked on
// the config page, the same buildPrompt evaluate prompt, the same honesty gate
// (a green result requires a clean exit AND a report actually written). URLs
// run SEQUENTIALLY while holding the tracker write token — evaluate agents
// write the tracker file themselves, and /api/run serializes on the same lock,
// so parallel runs would race the tracker. Streams NDJSON events the client job
// runner parses: {type:"status"|"text"|"item"|"done"|"error"}.
import fs from "node:fs";
import path from "node:path";
import { resolveCli } from "@/lib/clis";
import { withModelFlag, hasNewCompletedReport } from "@/lib/run-cli-support.mjs";
import { spawnHeadlessCli } from "@/lib/spawn-cli.mjs";
import { careerOpsRoot, readMemory, readInbox, readScanDates } from "@/lib/career-ops";
import { buildPrompt } from "@/lib/run-prompts.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const MAX_URLS = 20;

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

  let cancelled = false;
  let currentChild: ReturnType<typeof spawnHeadlessCli> | null = null;
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (ev: Record<string, unknown>) => {
        if (closed) return;
        controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
      };
      // A single evaluation can stay silent for minutes; nothing downstream can
      // tell that from a hung request, and the browser/proxy drops the stream.
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

      // One token for the whole batch: evaluate agents write the tracker file,
      // and /api/run serializes every evaluate on the same lock — holding it
      // here keeps the batch mutually exclusive with single evaluates too.
      const writeToken = acquireTrackerWrite();
      let ok = 0;
      let failed = 0;

      try {
        for (const [i, url] of urls.entries()) {
          if (cancelled) break;
          send({ type: "status", label: `[${i + 1}/${urls.length}] ${url}` });
          const postedAt = inboxPostedAt.get(url) ?? scanDates.get(url);
          const prompt = buildPrompt({ kind: "evaluate", input: url, memory: readMemory(), today, postedAt });
          // Plain-text argv (spec.args), not streamArgs: the batch route reads
          // the agent's output as text and only extracts the VERDICT line —
          // per-event parsing is /api/run's single-run concern.
          const args = withModelFlag(spec.args(prompt), spec.model, model);
          const reportsBefore = reportEntries();

          const outcome = await new Promise<{ cleanExit: boolean; sawError: boolean; verdict: string | null }>((resolve) => {
            let sawError = false;
            let verdict: string | null = null;
            const child = spawnHeadlessCli(binPath, args, { cwd: root, env: process.env });
            currentChild = child;
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
              send({ type: "text", text: `❌ ${url}: ${err.message}\n` });
              resolve({ cleanExit: false, sawError: true, verdict: null });
            });
            child.on("close", (code) => {
              resolve({ cleanExit: code === 0, sawError, verdict });
            });
          });
          currentChild = null;
          if (cancelled) break;

          const wroteReport = hasNewCompletedReport(reportsBefore, reportEntries());
          const itemOk = outcome.cleanExit && !outcome.sawError && wroteReport;
          if (itemOk) ok++;
          else failed++;
          send({
            type: "item",
            url,
            ok: itemOk,
            score: itemOk && outcome.verdict ? parseFloat((outcome.verdict.match(/([0-5](?:\.\d)?)/) ?? [])[1] ?? "") || null : null,
            // Honesty gate, same as /api/run: a run that errored or never wrote
            // its report is surfaced, never banked as a confident score.
            reason: itemOk
              ? undefined
              : !outcome.cleanExit || outcome.sawError
                ? "the run hit an error before finishing — re-run it to verify"
                : "the worker ran but never saved a report/tracker row",
          });
          send({
            type: "text",
            text: itemOk
              ? `✅ [${i + 1}/${urls.length}] done: ${url}${outcome.verdict ? ` — ${outcome.verdict}` : ""}\n`
              : `⚠️ [${i + 1}/${urls.length}] NOT recorded: ${url}\n`,
          });
        }
        if (cancelled) {
          send({ type: "error", msg: "Batch cancelled." });
        } else {
          send({ type: "done", ok, failed });
        }
      } finally {
        releaseTrackerWrite(writeToken);
        close();
      }
    },
    cancel() {
      cancelled = true;
      // SIGTERM the in-flight evaluation; the loop checks `cancelled` between
      // URLs and stops before spawning the next one.
      try {
        currentChild?.kill("SIGTERM");
      } catch {
        /* ignore */
      }
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
