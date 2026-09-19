"use client";

import { useEffect, useState } from "react";
import { Check, X, Loader2, AlertTriangle, Clock } from "lucide-react";
import type { Job } from "@/components/jobs/job-store";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";
import { fmtDuration } from "@/lib/format";
import { doneDurationSeconds, useJobTiming } from "@/lib/eval-duration-client";
import { formatRunEngine } from "@/lib/cli-labels.mjs";
import { ReportNumLink } from "@/components/report-num-link";

// Humanize raw agent tool names into what the user actually cares about, so a
// multi-minute evaluation reads as progress instead of a cryptic tool dump (#8).
const STEP_LABEL_KEYS: Record<string, string> = {
  WebFetch: "jobs.stepWebFetch",
  WebSearch: "jobs.stepWebSearch",
  Read: "jobs.stepRead",
  Glob: "jobs.stepGlob",
  Grep: "jobs.stepGrep",
  Write: "jobs.stepWrite",
  Edit: "jobs.stepEdit",
  NotebookEdit: "jobs.stepNotebookEdit",
  Bash: "jobs.stepBash",
  TodoWrite: "jobs.stepTodoWrite",
  Task: "jobs.stepTask",
};
const humanizeStep = (
  label: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string => t(STEP_LABEL_KEYS[label] ?? label);

// Auth/sign-in failures are the most common real error — detect them so we can give
// a concrete next step instead of a dead end (#8).
function isAuthError(job: Job): boolean {
  if (job.status !== "error") return false;
  const hay = `${job.steps[job.steps.length - 1]?.label ?? ""} ${job.text}`.toLowerCase();
  return /auth|login|sign[ -]?in|credential|api[ -]?key|unauthorized|not authenticated|installed and authenticated/.test(hay);
}

const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// Tick once a second WHILE running so a long evaluation visibly counts up (never
// looks frozen). Stops re-rendering as soon as the job settles.
function useElapsed(running: boolean, startedAt: number): number {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, startedAt]);
  return Math.max(0, now - startedAt);
}

// The ONE worker card — a pure function of a Job. Rendered in three surfaces:
// the sidebar tray (variant="tray", inside WorkerPills' Link), inline in the
// assistant chat (variant="inline"), and conceptually the /jobs/[id] timeline.
// Keeping it single is what guarantees the human UI and the agentic UI stay
// visually identical. TONE + pillTone live here (the canonical source).

export const TONE = {
  good: { bar: "bg-emerald-500/70", chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", icon: "text-emerald-500" },
  warn: { bar: "bg-amber-500/70", chip: "bg-amber-500/15 text-amber-700 dark:text-amber-400", icon: "text-amber-500" },
  bad: { bar: "bg-red-400/70", chip: "bg-red-500/15 text-red-700 dark:text-red-400", icon: "text-red-400" },
  muted: { bar: "bg-zinc-400/50", chip: "bg-surface-hover text-muted", icon: "text-zinc-400" },
} as const;

export function pillTone(j: Job): keyof typeof TONE {
  if (j.status === "error") return "bad";
  if (j.status === "queued") return "muted";
  if (j.status === "done") return j.result?.tone ?? "muted";
  return "muted";
}

export function WorkerCard({
  job,
  variant = "tray",
  trailing,
}: {
  job: Job;
  variant?: "tray" | "inline";
  trailing?: React.ReactNode;
}) {
  const tone = TONE[pillTone(job)];
  const running = job.status === "running";
  const queued = job.status === "queued";
  const elapsed = useElapsed(running, job.startedAt);
  const { t } = useI18n();
  const rawLast = job.steps[job.steps.length - 1]?.label;
  const last = rawLast ? humanizeStep(rawLast, t) : undefined;
  const bottom = job.status === "done" && job.result?.summary ? job.result.summary : last;
  const inline = variant === "inline";
  const hasScore = job.result?.score != null;
  const authError = isAuthError(job);
  const tokens = job.status === "done" ? job.cost?.tokens ?? 0 : 0;
  // 评估用时 (ADR-0016): running keeps the live tick above; DONE prefers the
  // TSV-sourced duration (resolving the report via /api/report-status), falling
  // back to the local startedAt→endedAt wall time when no report is resolvable.
  const { reportNum, entry } = useJobTiming(job);
  const doneSecs = job.status === "done" ? doneDurationSeconds(entry, job) : null;
  // ADR-0043 运行引擎（派发时请求的运行时+模型，不是实际加载的）：有就显示，
  // 没有就不占位（列表里缺失 = 无记录，只有详情页才明说「未记录」）。
  const engineText = (() => {
    const engine = formatRunEngine(job.cliId, job.model);
    return engine ? t("jobs.runEngine", { engine }) : null;
  })();

  return (
    <div className={cn(inline && "rounded-xl border border-border bg-surface/60 p-2.5")}>
      <div className="flex items-center gap-2">
        {running ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-brand" />
        ) : queued ? (
          <Clock className="size-3 shrink-0 text-zinc-400" />
        ) : job.status === "error" ? (
          <AlertTriangle className={cn("size-3 shrink-0", tone.icon)} />
        ) : (
          <Check className={cn("size-3 shrink-0", tone.icon)} />
        )}
        <span className={cn("truncate font-medium", inline ? "text-sm" : "text-xs")}>{job.title}</span>
        {reportNum && <ReportNumLink n={reportNum} className={cn("shrink-0 cursor-pointer tabular-nums text-faint transition-colors hover:text-brand", inline ? "text-xs" : "text-[10px]")} />}
        {hasScore && (
          <span
            className={cn(
              "ml-auto shrink-0 rounded px-1 py-0.5 font-semibold tabular-nums",
              inline ? "text-xs" : "text-[10px]",
              tone.chip,
            )}
          >
            {job.result!.score}
          </span>
        )}
        {trailing != null && (
          <span className={cn("shrink-0", hasScore ? "ml-1" : "ml-auto")}>{trailing}</span>
        )}
      </div>
      <div className={cn("mt-1.5 w-full overflow-hidden rounded-full bg-surface-hover", inline ? "h-1.5" : "h-1")}>
        {running ? (
          <div className="job-indeterminate h-full w-full" />
        ) : queued ? (
          <div className={cn("h-full w-full", tone.bar)} />
        ) : (
          <div className={cn("h-full w-full rounded-full", tone.bar)} />
        )}
      </div>
      {(bottom || running || queued) && (
        <div className={cn("mt-1 truncate text-faint", inline ? "text-xs" : "text-[10px]")}>
          {queued
            ? `${t("jobs.queued")}${job.queuedPos != null ? ` · ${t("jobs.queuedPos", { n: job.queuedPos })}` : ""}`
            : running
              // ADR-0042 决议 1：收尾段比最后一步更「新」——route 已在做落盘/渲染。
              ? `${job.phase === "finalizing" ? t("jobs.phaseFinalizing") : (last ?? t("jobs.working"))} · ${fmtElapsed(elapsed)}`
              : bottom}
        </div>
      )}
      {authError && (
        <div className={cn("mt-1 text-amber-700 dark:text-amber-400", inline ? "text-xs" : "text-[10px]")}>
          {t("jobs.authErrorHint")}
        </div>
      )}
      {doneSecs != null && (
        <div className={cn("mt-1 flex items-center gap-1 text-faint tabular-nums", inline ? "text-xs" : "text-[10px]")} title={t("jobs.evalDuration")}>
          <Clock className="size-3 shrink-0" /> {fmtDuration(doneSecs)}
        </div>
      )}
      {engineText && (
        <div
          className={cn("mt-1 truncate text-faint", inline ? "text-xs" : "text-[10px]")}
          title={`${engineText} — ${t("jobs.runEngineHint")}`}
        >
          {engineText}
        </div>
      )}
      {tokens > 0 && (
        <div className={cn("mt-1 text-faint tabular-nums", inline ? "text-xs" : "text-[10px]")}>
          {fmtTokens(tokens)} {t("jobs.tokens")}{job.cost?.usd != null ? ` · $${job.cost.usd.toFixed(2)}` : ""}
        </div>
      )}
    </div>
  );
}

// Re-exported icon used by callers that compose their own trailing affordances.
export { X as DismissIcon };
