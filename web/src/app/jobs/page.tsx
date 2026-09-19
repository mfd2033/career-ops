"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, AlertTriangle, Loader2, Trash2, Clock } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { pillTone } from "@/components/jobs/worker-pills";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";
import { fmtDuration } from "@/lib/format";
import { doneDurationSeconds, useJobTiming } from "@/lib/eval-duration-client";
import { ReportNumLink } from "@/components/report-num-link";
import { formatRunEngine } from "@/lib/cli-labels.mjs";
import type { Job } from "@/components/jobs/job-store";

const TONE_CHIP = {
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  bad: "bg-red-500/15 text-red-700 dark:text-red-400",
  muted: "bg-surface-hover text-muted",
} as const;

const STATUS_LABEL: Record<string, string> = {
  running: "jobs.statusRunning",
  queued: "jobs.queued",
  done: "jobs.statusDone",
  error: "jobs.statusError",
};

/** Shape of one server run-ledger entry (producer: web/src/lib/run-ledger.mjs
 *  via GET /api/runs/history — ADR-0027 follow-up observability fix). */
type RunLedgerEntry = {
  id: string;
  kind: string;
  input: string;
  title: string;
  page?: string;
  status: "done" | "error";
  startedAt: number;
  finishedAt: number;
  msg?: string;
  // ADR-0043 运行引擎：本功能前的记录没有这两个字段（按「未记录」处理）。
  cliId?: string;
  model?: string;
};

export default function JobsHistory() {
  const { jobs, clearFinished } = useJobs();
  const { t } = useI18n();

  // Server run ledger (ADR-0027 follow-up): terminated runs dispatched outside
  // this browser (API, script, another tab) exist only in the server ledger.
  // Merge them in, deduped by runId — a card that knows its runId wins (it has
  // richer live state); ledger-only rows fill the gaps so a finished checkup
  // can never vanish from history again.
  const [ledgerRuns, setLedgerRuns] = useState<RunLedgerEntry[]>([]);
  useEffect(() => {
    fetch("/api/runs/history")
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((d) => setLedgerRuns(d.runs ?? []))
      .catch(() => {});
  }, []);

  const knownRunIds = new Set(jobs.map((j) => j.runId).filter(Boolean));
  const ledgerOnly: Job[] = ledgerRuns
    .filter((r) => !knownRunIds.has(r.id))
    .map((r) => ({
      id: r.id,
      title: r.title,
      page: r.page,
      input: r.input,
      kind: r.kind,
      runId: r.id,
      cliId: r.cliId,
      model: r.model,
      status: r.status === "done" ? "done" : "error",
      steps: [],
      text: r.msg || "",
      startedAt: r.startedAt,
      endedAt: r.finishedAt,
    }));
  const merged = [...jobs, ...ledgerOnly].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">{t("jobs.workers")}</h1>
          <p className="mt-1 text-sm text-muted">
            {t("jobs.historyIntro")}<span className="tabular-nums">{merged.length}</span>{t("jobs.total")}
          </p>
        </div>
        {merged.some((j) => j.status !== "running" && j.status !== "queued") && (
          <button
            onClick={clearFinished}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <Trash2 className="size-3.5" /> {t("jobs.clearFinished")}
          </button>
        )}
      </div>

      {merged.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center text-sm text-muted">
          {t("jobs.empty")}
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
          {merged.map((j) => (
            <JobsRow key={j.id} job={j} />
          ))}
        </ul>
      )}
    </div>
  );
}

// One history row as its own component: the 评估用时 + report-number resolution
// needs hooks (useJobTiming), which can't be called inside the map callback.
function JobsRow({ job: j }: { job: Job }) {
  const { t } = useI18n();
  const tone = pillTone(j);
  const { reportNum, entry } = useJobTiming(j);
  const secs = j.status === "done" ? doneDurationSeconds(entry, j) : null;
  // The pool cards carry "#N" as their subtitle — render it as the report jump
  // instead of duplicating it beside the title.
  const subtitleIsNum = !!j.subtitle && /^#\d+$/.test(j.subtitle);
  // ADR-0043 运行引擎：列表里缺失不占位（详情页才写「未记录」）。
  const engine = formatRunEngine(j.cliId, j.model);
  const engineText = engine ? t("jobs.runEngine", { engine }) : null;
  return (
    <li>
      <Link href={`/jobs/${j.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover">
        <span className="hidden shrink-0 text-xs capitalize text-faint sm:block">{t(STATUS_LABEL[j.status] ?? j.status)}</span>
        {j.status === "queued" && j.queuedPos != null && (
          <span className="shrink-0 text-xs tabular-nums text-faint">#{j.queuedPos}</span>
        )}
        {j.status === "queued" ? (
          <Clock className="size-4 shrink-0 text-zinc-400" />
        ) : j.status === "running" ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
        ) : j.status === "error" ? (
          <AlertTriangle className="size-4 shrink-0 text-red-400" />
        ) : (
          <Check className="size-4 shrink-0 text-emerald-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {j.title}
            {reportNum && !subtitleIsNum && (
              <>
                {" "}
                <ReportNumLink n={reportNum} className="text-xs font-normal text-faint transition-colors hover:text-brand" />
              </>
            )}
          </div>
          {subtitleIsNum ? (
            <div className="truncate text-xs text-muted">
              <ReportNumLink n={reportNum!} className="text-xs text-muted transition-colors hover:text-brand" />
            </div>
          ) : (
            (j.subtitle || j.result?.summary) && <div className="truncate text-xs text-muted">{j.result?.summary || j.subtitle}</div>
          )}
          {engineText && (
            <div className="truncate text-[11px] text-faint" title={`${engineText} — ${t("jobs.runEngineHint")}`}>
              {engineText}
            </div>
          )}
        </div>
        {secs != null && (
          <span className="hidden shrink-0 items-center gap-1 text-xs tabular-nums text-faint sm:flex" title={t("jobs.evalDuration")}>
            <Clock className="size-3" /> {fmtDuration(secs)}
          </span>
        )}
        {j.result?.score != null && (
          <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums", TONE_CHIP[tone])}>
            {j.result.score}/5
          </span>
        )}
        <span className="hidden shrink-0 text-xs capitalize text-faint sm:block">{t(STATUS_LABEL[j.status] ?? j.status)}</span>
      </Link>
    </li>
  );
}
