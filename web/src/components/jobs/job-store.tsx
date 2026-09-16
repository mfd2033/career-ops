"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { scoreTone } from "@/lib/format";
import { readSavedCliId, readSavedModel, resolveCliId } from "@/lib/saved-cli";
import { useI18n } from "@/lib/i18n/context";
import { reconcileJobsWithLedger } from "@/lib/job-ledger-reconcile.mjs";

export type JobStep = { kind: "tool" | "status"; label: string; ts: number };
export type JobResult = { score: number | null; summary: string; tone: "good" | "warn" | "bad" | "muted" };

// Server snapshot shape — see /api/active-runs and lib/core/concurrency-pool.ts.
// The pool is the single authority on what's running vs queued, for EVERY source
// (web single-run = source "run", web/extension batch = source "batch").
type PoolEntry = {
  id: string;
  url: string;
  title: string;
  reportNum?: number;
  source: "run" | "batch";
};
type PoolRunning = PoolEntry & { startedAt: number };
type PoolQueued = PoolEntry & { enqueuedAt: number; position: number };
type ActiveRunApi = { running: PoolRunning[]; queued: PoolQueued[] };

export type Job = {
  id: string;
  title: string;
  subtitle?: string;
  page?: string; // route the job was launched from / refers to
  input?: string; // the URL/posting it processed (links inbox rows to their worker)
  kind?: string;
  // The report this worker references, when it is known at LAUNCH (pdf). Not
  // every kind can know one: an evaluate worker's number is reserved by the
  // agent mid-run, so that kind resolves via the posting URL instead (ADR-0018).
  reportNum?: string;
  batchId?: string; // groups jobs fired together (e.g. "evaluate all Anthropic")
  /** The server-side run id (from /api/run's {runId}), when known. Joins the
   *  localStorage card to the server run ledger so /jobs can dedupe the two. */
  runId?: string;
  status: "running" | "queued" | "done" | "error";
  // Set ONLY by the localStorage restore when it guess-marks a previously
  // "running" card as interrupted (ADR-0031): the marker lets the run-ledger
  // reconciliation tell a guess apart from a real SSE-delivered error and
  // upgrade it to the ledger's true terminal state.
  interruptedAt?: number;
  // For a server-sourced (pool) card: its pool id + whether it was queued, so the
  // dismiss action can route to the right cancel path (dequeue via API).
  active?: boolean;
  queuedPos?: number; // 1-based FIFO position while waiting for a pool slot
  steps: JobStep[];
  text: string;
  result?: JobResult;
  cost?: { tokens: number; usd?: number }; // per-run token cost (Claude result event) — local only
  startedAt: number;
  endedAt?: number;
};

type StartOpts = { title: string; subtitle?: string; kind: string; input: string; page?: string; batchId?: string; urls?: string[]; reportNum?: string };

type Ctx = {
  jobs: Job[];
  startJob: (opts: StartOpts) => string | null;
  removeJob: (id: string) => void;
  cancelJob: (id: string) => void;
  clearFinished: () => void;
};

const JobsContext = createContext<Ctx | null>(null);
export function useJobs() {
  const c = useContext(JobsContext);
  if (!c) throw new Error("useJobs must be used within <JobsProvider>");
  return c;
}

const JOBS_KEY = "career-ops:jobs";

function parseVerdict(text: string): JobResult {
  const m = text.match(/VERDICT:\s*([\d.]+)\s*\/\s*5\s*[—:|-]+\s*(.+)/i);
  if (m) {
    const score = parseFloat(m[1]);
    return { score, summary: m[2].trim().replace(/\s+/g, " ").slice(0, 90), tone: scoreTone(`${score}`) };
  }
  const s = text.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);
  if (s) {
    const score = parseFloat(s[1]);
    return { score, summary: "", tone: scoreTone(`${score}`) };
  }
  return { score: null, summary: "", tone: "muted" };
}

// Per-job accumulation for a single-run worker whose events arrive on the
// /api/events multiplexed channel (ADR-0020) — the old transport kept these as
// closure locals of the per-task stream reader.
type RunAcc = {
  opts: StartOpts;
  text: string;
  verdictLine: string; // latched separately so the 8000-char tail can't drop it
  doneTokens: number; // per-run token cost, forwarded on the done event (#6)
  doneCostUsd: number | null;
  steps: JobStep[];
  lastSeq: number; // bus replay dedup: skip events already applied before a reconnect
};

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeRuns, setActiveRuns] = useState<ActiveRunApi>({ running: [], queued: [] });
  const batchControllers = useRef(new Map<string, AbortController>()); // batch jobs only — they still hold their own NDJSON stream
  const runIds = useRef(new Map<string, string>()); // server runId -> local jobId (single-run workers, ADR-0020)
  const accs = useRef(new Map<string, RunAcc>());
  const removed = useRef(new Set<string>()); // cards removed before their POST /api/run even returned
  const seq = useRef(0);
  const loaded = useRef(false);
  const { t } = useI18n();

  // Poll the server-wide global concurrency-pool snapshot. Evaluations started
  // from the BOSS直聘 EXTENSION never touch this process's job-store, so this is
  // the only channel that surfaces them in the worker list; it also reports which
  // tasks are still QUEUED behind a full pool (so a worker shows 排队中, not a lie
  // that it's running). Cleaned up on unmount; entries vanish as the server
  // unregisters/settles them.
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/active-runs");
        if (!res.ok) return;
        const data = (await res.json()) as ActiveRunApi;
        if (live) setActiveRuns({
          running: Array.isArray(data.running) ? data.running : [],
          queued: Array.isArray(data.queued) ? data.queued : [],
        });
      } catch {
        /* transient — leave the last good snapshot */
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  // The ONE worker-event channel (ADR-0020): every single-run worker publishes
  // its tool/status/text/done/error events to /api/events tagged with its
  // runId, and this effect holds ONE connection for all of them (with
  // reconnect + buffer replay; per-event `seq` dedups the replay). Before
  // ADR-0020 each task held its own streaming response, and ~6 concurrent
  // tasks exhausted the browser's 6 sockets per HTTP/1.1 host — every click
  // on the page stalled until tasks finished.
  useEffect(() => {
    let live = true;
    const controller = new AbortController();

    const finishJob = (id: string, status: "done" | "error", lastLabel?: string) => {
      const acc = accs.current.get(id);
      if (!acc) return;
      const result = status === "done" ? parseVerdict(acc.verdictLine || acc.text) : undefined;
      const cost = status === "done" && acc.doneTokens > 0 ? { tokens: acc.doneTokens, usd: acc.doneCostUsd ?? undefined } : undefined;
      setJobs((js) =>
        js.map((j) =>
          j.id === id
            ? { ...j, status, result, cost, endedAt: Date.now(), steps: lastLabel ? [...j.steps, { kind: "status", label: lastLabel, ts: Date.now() }] : j.steps }
            : j,
        ),
      );
      // persist a readable log file so the CLI/assistant can read past runs
      if (status === "done") {
        fetch("/api/runs/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, title: acc.opts.title, subtitle: acc.opts.subtitle, page: acc.opts.page, input: acc.opts.input, result, cost, steps: acc.steps, output: acc.text }),
        }).catch(() => {});
        // Tell server-snapshot surfaces (Today, pipeline) to refetch — the
        // worker just wrote a real tracker row / report they don't yet see.
        if (typeof window !== "undefined" && ["evaluate", "pdf", "batch-evaluate", "checkup"].includes(acc.opts.kind)) {
          window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: acc.opts.kind, input: acc.opts.input } }));
        }
      }
      accs.current.delete(id);
      for (const [runId, jid] of runIds.current) if (jid === id) runIds.current.delete(runId);
    };

    const handleEvent = (jobId: string, ev: { type: string; [key: string]: unknown }) => {
      const acc = accs.current.get(jobId);
      if (!acc) return;
      // Replay dedup: after a channel reconnect /api/events replays each run's
      // buffer — skip anything this job already applied.
      if (typeof ev.seq === "number") {
        if (ev.seq <= acc.lastSeq) return;
        acc.lastSeq = ev.seq;
      }
      if (ev.type === "tool") {
        acc.steps.push({ kind: "tool", label: ev.name as string, ts: Date.now() });
        setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, steps: [...j.steps, { kind: "tool", label: ev.name as string, ts: Date.now() }] } : j)));
      } else if (ev.type === "status") {
        acc.steps.push({ kind: "status", label: ev.label as string, ts: Date.now() });
        setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, steps: [...j.steps, { kind: "status", label: ev.label as string, ts: Date.now() }] } : j)));
      } else if (ev.type === "text") {
        const full = acc.text + (ev.text as string);
        const vm = full.match(/VERDICT:[^\n]*/i);
        if (vm) acc.verdictLine = vm[0];
        acc.text = full.slice(-8000);
        const tail = acc.text;
        setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, text: tail } : j)));
      } else if (ev.type === "done") {
        if (typeof ev.tokens === "number") acc.doneTokens = ev.tokens;
        if (typeof ev.costUsd === "number") acc.doneCostUsd = ev.costUsd;
        finishJob(jobId, "done", t("jobs.stepDone"));
      } else if (ev.type === "error") {
        finishJob(jobId, "error", (ev.msg as string) || t("jobs.stepError"));
      }
      // keepalive / unknown event types: ignored.
    };

    const connect = async () => {
      // Reconnect loop: on a dropped channel, re-subscribe (the server replays
      // live runs' buffers so no worker output is lost across the gap).
      for (;;) {
        if (!live) return;
        try {
          const res = await fetch("/api/events", { signal: controller.signal, cache: "no-store" });
          if (!res.ok || !res.body) throw new Error("events channel unavailable");
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const frame = JSON.parse(line) as { runId?: string; type?: string; [key: string]: unknown };
                if (frame.type === "keepalive") continue;
                if (!frame.runId) continue;
                const jobId = runIds.current.get(frame.runId);
                if (!jobId) continue; // another tab's / extension's run — surfaced via the active-runs poll instead
                handleEvent(jobId, frame as { type: string; [key: string]: unknown });
              } catch {
                /* skip malformed frame */
              }
            }
          }
        } catch {
          /* dropped — fall through to the backoff */
        }
        if (!live) return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    connect();
    return () => {
      live = false;
      controller.abort();
    };
    // finishJob/handleEvent close over `t` (stable per locale) and refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Merge server pool entries into the visible job list.
  //
  //   * source "batch" (in-app batch + BOSS extension) becomes its own ephemeral
  //     worker card — each batch URL is a separate worker, queued or running.
  //   * source "run" (single-card evaluate/pdf) is started by THIS process's
  //     job-store, so it already has a local card; we DO NOT add a duplicate, we
  //     only OVERTIDE that card to "排队中" while the pool reports it queued.
  //
  // Cards are keyed by a stable `active-{id}` id (NOT the URL, which could
  // collide with an in-app job's input); active cards are never persisted.
  const queuePosByRunInput = new Map<string, number>();
  for (const q of activeRuns.queued) if (q.source === "run") queuePosByRunInput.set(q.url, q.position);
  const activeCards: Job[] = [
    ...activeRuns.running
      .filter((r) => !(r.source === "run" && jobs.some((j) => j.input === r.url)))
      .map((r): Job => ({
        id: `active-${r.id}`,
        title: r.title,
        subtitle: r.reportNum != null ? `#${r.reportNum}` : undefined,
        page: "/jobs",
        input: r.url,
        kind: "batch-evaluate",
        status: "running",
        active: true,
        steps: [{ kind: "status", label: t("jobs.working"), ts: r.startedAt }],
        text: "",
        startedAt: r.startedAt,
      })),
    ...activeRuns.queued
      .filter((q) => !(q.source === "run" && jobs.some((j) => j.input === q.url)))
      .map((q): Job => ({
        id: `active-${q.id}`,
        title: q.title,
        subtitle: q.reportNum != null ? `#${q.reportNum}` : undefined,
        page: "/jobs",
        input: q.url,
        kind: "batch-evaluate",
        status: "queued",
        active: true,
        queuedPos: q.position,
        steps: [{ kind: "status", label: t("jobs.queued"), ts: q.enqueuedAt }],
        text: "",
        startedAt: q.enqueuedAt,
      })),
  ];
  // Local single-run jobs flip to 排队中 when the pool reports them queued
  // (their events keep flowing on the channel in the background, ADR-0020).
  const localDisplay = jobs.map((j) => {
    const pos = j.input ? queuePosByRunInput.get(j.input) : undefined;
    return pos != null ? { ...j, status: "queued" as const, queuedPos: pos } : j;
  });
  const visibleJobs: Job[] = [...activeCards, ...localDisplay];

  // restore history
  useEffect(() => {
    try {
      const raw = localStorage.getItem(JOBS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        // anything left "running" from a previous session is stale → mark interrupted.
        // The interruptedAt marker keeps this a GUESS (ADR-0031): the run-ledger
        // reconciliation below can still upgrade such cards to the ledger's real
        // terminal state, which a plain "error" status would block forever.
        setJobs(arr.map((j: Job) => (j.status === "running" ? { ...j, status: "error", interruptedAt: Date.now(), steps: [...(j.steps || []), { kind: "status", label: t("jobs.stepInterrupted"), ts: Date.now() }] } : j)));
      }
    } catch {
      /* ignore */
    }
    loaded.current = true;
  }, []);

  // Zombie-card reconciliation (ADR-0031): a card whose /api/events terminal
  // event was missed (tab sleep / dropped connection) stays "running" forever,
  // and /jobs's "card wins" merge then shadows the server ledger's real
  // outcome — the #27 checkup spun 30+ minutes on screen after erroring at 88
  // seconds. Poll the TERMINATED-run ledger at low frequency and let
  // reconcileJobsWithLedger cure stale cards; live cards (accumulator present)
  // stay owned by the SSE path. No co-job-done / runs/save side effects here:
  // a reconciled card has no trustworthy local accumulation.
  useEffect(() => {
    const reconcile = async () => {
      try {
        const res = await fetch("/api/runs/history", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { runs?: unknown[] };
        const runs = Array.isArray(data.runs) ? data.runs : [];
        setJobs((js) => {
          const r = reconcileJobsWithLedger(js, runs as never[], {
            isLive: (id: string) => accs.current.has(id),
            now: Date.now(),
            doneLabel: t("jobs.stepDone"),
            errorLabel: t("jobs.stepError"),
          });
          return r.healed.length ? r.jobs : js; // no heal → no re-render
        });
      } catch {
        /* transient — the next tick retries */
      }
    };
    reconcile();
    const timer = setInterval(reconcile, 15000);
    return () => clearInterval(timer);
    // reconcile closes over refs and `t` (stable per locale) only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(0, 40)));
    } catch {
      /* quota */
    }
  }, [jobs]);

  const patch = useCallback((id: string, fn: (j: Job) => Job) => {
    setJobs((js) => js.map((j) => (j.id === id ? fn(j) : j)));
  }, []);

  const startJob = useCallback(
    (opts: StartOpts): string | null => {
      const id = `job-${Date.now()}-${seq.current++}`;
      const job: Job = {
        id,
        title: opts.title,
        subtitle: opts.subtitle,
        page: opts.page,
        input: opts.input,
        kind: opts.kind,
        reportNum: opts.reportNum,
        batchId: opts.batchId,
        status: "running",
        steps: [{ kind: "status", label: t("jobs.stepStarting"), ts: Date.now() }],
        text: "",
        startedAt: Date.now(),
      };
      setJobs((js) => [job, ...js]);
      removed.current.delete(id);

      if (!opts.urls) {
        // Single-run worker (evaluate/pdf/fix-portal): POST returns {runId}
        // immediately (ADR-0020) and the worker's events arrive on the shared
        // /api/events channel — this tab holds NO per-task connection.
        (async () => {
          const cliId = readSavedCliId() || (await resolveCliId());
          const model = readSavedModel() || undefined;
          if (!cliId) {
            patch(id, (j) => ({
              ...j,
              status: "error",
              endedAt: Date.now(),
              steps: [...j.steps, { kind: "status", label: t("jobs.stepNoCli"), ts: Date.now() }],
            }));
            return;
          }
          accs.current.set(id, { opts, text: "", verdictLine: "", doneTokens: 0, doneCostUsd: null, steps: [], lastSeq: 0 });
          try {
            const res = await fetch("/api/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kind: opts.kind, input: opts.input, cliId, model }),
            });
            if (!res.ok) {
              const e = await res.json().catch(() => ({}));
              accs.current.delete(id);
              patch(id, (j) => ({
                ...j,
                status: "error",
                endedAt: Date.now(),
                steps: [...j.steps, { kind: "status", label: e.error || t("jobs.stepFailedToStart"), ts: Date.now() }],
              }));
              return;
            }
            const { runId, error } = (await res.json()) as { runId?: string; error?: string };
            if (!runId) {
              accs.current.delete(id);
              patch(id, (j) => ({
                ...j,
                status: "error",
                endedAt: Date.now(),
                steps: [...j.steps, { kind: "status", label: error || t("jobs.stepFailedToStart"), ts: Date.now() }],
              }));
              return;
            }
            if (removed.current.has(id)) {
              // The card was dismissed while the POST was in flight — cancel the
              // just-registered run instead of letting it work headless unowned.
              fetch("/api/run/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }) }).catch(() => {});
              accs.current.delete(id);
              return;
            }
            runIds.current.set(runId, id);
            // Persist the runId onto the card so /jobs can dedupe this card
            // against the server run ledger (same run, one history row).
            patch(id, (j) => ({ ...j, runId }));
            // Events (including the tail of anything published between the
            // server registering the run and this map write) are recovered by
            // the channel's buffer replay; `seq` dedup keeps it exactly-once.
          } catch {
            accs.current.delete(id);
            patch(id, (j) => ({
              ...j,
              status: "error",
              endedAt: Date.now(),
              steps: [...j.steps, { kind: "status", label: t("jobs.stepConnectionError"), ts: Date.now() }],
            }));
          }
        })();
        return id;
      }

      // Batch mode (opts.urls) goes to the dedicated batch-evaluate endpoint
      // — one bounded-concurrency evaluator run for all URLs instead of N
      // single-evaluate agent runs. It STILL streams NDJSON on its own
      // response (the BOSS直聘 extension parses this endpoint too, and one
      // batch = one held connection, well inside the 6-socket budget).
      const acc: RunAcc = { opts, text: "", verdictLine: "", doneTokens: 0, doneCostUsd: null, steps: [], lastSeq: 0 };
      accs.current.set(id, acc);
      // AbortController so a batch card can be truly cancelled (the stream's
      // server-side cancel() terminates the whole batch run).
      const controller = new AbortController();
      batchControllers.current.set(id, controller);

      (async () => {
        const cliId = readSavedCliId() || (await resolveCliId());
        const model = readSavedModel() || undefined;
        if (!cliId) {
          accs.current.delete(id);
          patch(id, (j) => ({
            ...j,
            status: "error",
            endedAt: Date.now(),
            steps: [...j.steps, { kind: "status", label: t("jobs.stepNoCli"), ts: Date.now() }],
          }));
          return;
        }
        const finish = (status: "done" | "error", lastLabel?: string) => {
          const result = status === "done" ? parseVerdict(acc.verdictLine || acc.text) : undefined;
          const cost = status === "done" && acc.doneTokens > 0 ? { tokens: acc.doneTokens, usd: acc.doneCostUsd ?? undefined } : undefined;
          patch(id, (j) => ({
            ...j,
            status,
            result,
            cost,
            endedAt: Date.now(),
            steps: lastLabel ? [...j.steps, { kind: "status", label: lastLabel, ts: Date.now() }] : j.steps,
          }));
          if (status === "done") {
            fetch("/api/runs/save", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, title: opts.title, subtitle: opts.subtitle, page: opts.page, input: opts.input, result, cost, steps: acc.steps, output: acc.text }),
            }).catch(() => {});
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: opts.kind, input: opts.input } }));
            }
          }
          accs.current.delete(id);
        };

        try {
          const res = await fetch("/api/batch-evaluate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ urls: opts.urls, cliId, model }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            const e = await res.json().catch(() => ({}));
            finish("error", e.error || t("jobs.stepFailedToStart"));
            return;
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const ev = JSON.parse(line);
                if (ev.type === "tool") {
                  acc.steps.push({ kind: "tool", label: ev.name, ts: Date.now() });
                  patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "tool", label: ev.name, ts: Date.now() }] }));
                } else if (ev.type === "status") {
                  acc.steps.push({ kind: "status", label: ev.label, ts: Date.now() });
                  patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "status", label: ev.label, ts: Date.now() }] }));
                } else if (ev.type === "text") {
                  const full = acc.text + ev.text;
                  const vm = full.match(/VERDICT:[^\n]*/i);
                  if (vm) acc.verdictLine = vm[0];
                  acc.text = full.slice(-8000);
                  const tail = acc.text;
                  patch(id, (j) => ({ ...j, text: tail }));
                } else if (ev.type === "done") {
                  if (typeof ev.tokens === "number") acc.doneTokens = ev.tokens;
                  if (typeof ev.costUsd === "number") acc.doneCostUsd = ev.costUsd;
                } else if (ev.type === "error") {
                  finish("error", ev.msg || t("jobs.stepError"));
                  return;
                }
              } catch {
                /* skip */
              }
            }
          }
          finish("done", t("jobs.stepDone"));
        } catch (e) {
          // A user-cancelled batch surfaces as AbortError once the controller.abort()
          // drops the stream — the card is already removed, so don't repaint an
          // error state for a deliberate cancel.
          if ((e as Error)?.name === "AbortError") return;
          finish("error", t("jobs.stepConnectionError"));
        }
      })();

      return id;
    },
    [patch, t],
  );

  const removeJob = useCallback((id: string) => {
    removed.current.add(id);
    // Batch job → abort its NDJSON stream (the server-side stream cancel
    // terminates the whole batch run).
    batchControllers.current.get(id)?.abort();
    batchControllers.current.delete(id);
    // Single-run job (ADR-0020) → explicit cancel by runId: queued runs are
    // dequeued before spawning, running ones get their CLI tree terminated.
    for (const [runId, jid] of runIds.current) {
      if (jid !== id) continue;
      runIds.current.delete(runId);
      fetch("/api/run/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      }).catch(() => {});
    }
    accs.current.delete(id);
    setJobs((js) => js.filter((j) => j.id !== id));
    // Server-sourced (pool) card → dequeue on the server by its pool id; the
    // next poll then no longer reports it (a running batch worker is left to the
    // batch's own whole-stream cancel, matching the existing running-cancel path).
    if (id.startsWith("active-")) {
      const poolId = id.slice("active-".length);
      fetch("/api/active-runs/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: poolId }),
      }).catch(() => {});
      setActiveRuns((s) => ({
        running: s.running.filter((r) => r.id !== poolId),
        queued: s.queued.filter((q) => q.id !== poolId),
      }));
    }
  }, []);

  const cancelJob = useCallback((id: string) => {
    removeJob(id);
    // Also clear finished for queued? no-op: remove handles both paths above.
  }, [removeJob]);

  const clearFinished = useCallback(() => setJobs((js) => js.filter((j) => j.status === "running" || j.status === "queued")), []);

  return <JobsContext.Provider value={{ jobs: visibleJobs, startJob, removeJob, cancelJob, clearFinished }}>{children}</JobsContext.Provider>;
}
