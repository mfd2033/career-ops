"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { scoreTone } from "@/lib/format";
import { readSavedCliId, readSavedModel, resolveCliId } from "@/lib/saved-cli";
import { useI18n } from "@/lib/i18n/context";

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
  batchId?: string; // groups jobs fired together (e.g. "evaluate all Anthropic")
  status: "running" | "queued" | "done" | "error";
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

type StartOpts = { title: string; subtitle?: string; kind: string; input: string; page?: string; batchId?: string; urls?: string[] };

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

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeRuns, setActiveRuns] = useState<ActiveRunApi>({ running: [], queued: [] });
  const controllers = useRef(new Map<string, AbortController>());
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
  // (their live stream sits in the background until a slot frees up).
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
        // anything left "running" from a previous session is stale → mark interrupted
        setJobs(arr.map((j: Job) => (j.status === "running" ? { ...j, status: "error", steps: [...(j.steps || []), { kind: "status", label: t("jobs.stepInterrupted"), ts: Date.now() }] } : j)));
      }
    } catch {
      /* ignore */
    }
    loaded.current = true;
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
        batchId: opts.batchId,
        status: "running",
        steps: [{ kind: "status", label: t("jobs.stepStarting"), ts: Date.now() }],
        text: "",
        startedAt: Date.now(),
      };
      setJobs((js) => [job, ...js]);
      // AbortController so a local card can be truly cancelled (dequeue + stop the
      // stream → the /api/run stream's cancel() dequeues from the pool's queue).
      const controller = new AbortController();
      controllers.current.set(id, controller);

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
        let text = "";
        let verdictLine = ""; // latched separately so the 8000-char tail can't drop it
        let doneTokens = 0; // per-run token cost, forwarded on the done event (#6)
        let doneCostUsd: number | null = null;
        const steps: JobStep[] = [];
        const finish = (status: "done" | "error", lastLabel?: string) => {
          const result = status === "done" ? parseVerdict(verdictLine || text) : undefined;
          const cost = status === "done" && doneTokens > 0 ? { tokens: doneTokens, usd: doneCostUsd ?? undefined } : undefined;
          patch(id, (j) => ({
            ...j,
            status,
            result,
            cost,
            endedAt: Date.now(),
            steps: lastLabel ? [...j.steps, { kind: "status", label: lastLabel, ts: Date.now() }] : j.steps,
          }));
          // persist a readable log file so the CLI/assistant can read past runs
          if (status === "done") {
            fetch("/api/runs/save", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, title: opts.title, subtitle: opts.subtitle, page: opts.page, input: opts.input, result, cost, steps, output: text }),
            }).catch(() => {});
            // Tell server-snapshot surfaces (Today, pipeline) to refetch — the
            // worker just wrote a real tracker row / report they don't yet see.
            // batch-evaluate writes many rows/reports in one run, same refresh need.
            if (typeof window !== "undefined" && ["evaluate", "pdf", "batch-evaluate"].includes(opts.kind)) {
              window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: opts.kind, input: opts.input } }));
            }
          }
        };

        try {
          // Batch mode (opts.urls) goes to the dedicated batch-evaluate endpoint
          // — one bounded-concurrency evaluator run for all URLs instead of N
          // single-evaluate agent runs. Everything else stays on /api/run.
          const res = await fetch(opts.urls ? "/api/batch-evaluate" : "/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts.urls ? { urls: opts.urls, cliId, model } : { kind: opts.kind, input: opts.input, cliId, model }),
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
                  steps.push({ kind: "tool", label: ev.name, ts: Date.now() });
                  patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "tool", label: ev.name, ts: Date.now() }] }));
                } else if (ev.type === "status") {
                  steps.push({ kind: "status", label: ev.label, ts: Date.now() });
                  patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "status", label: ev.label, ts: Date.now() }] }));
                } else if (ev.type === "text") {
                  const full = text + ev.text;
                  const vm = full.match(/VERDICT:[^\n]*/i);
                  if (vm) verdictLine = vm[0];
                  text = full.slice(-8000);
                  patch(id, (j) => ({ ...j, text }));
                } else if (ev.type === "done") {
                  // finish happens on stream-close; capture the per-run cost it carries
                  if (typeof ev.tokens === "number") doneTokens = ev.tokens;
                  if (typeof ev.costUsd === "number") doneCostUsd = ev.costUsd;
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
          // A user-cancelled job surfaces as AbortError once the controller.abort()
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
    // Local job → abort its stream so the server dequeues (a queued local card
    // truly stops) / terminates (a running local card truly stops).
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
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
