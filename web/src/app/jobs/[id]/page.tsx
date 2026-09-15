"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X, Clock } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { HeroGlow } from "@/components/hero-glow";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n/context";
import { useJobTiming } from "@/lib/eval-duration-client";
import { EvalTimingPanel } from "@/components/eval-timing-panel";
import { ReportNumLink } from "@/components/report-num-link";
import { goBackOr } from "@/lib/nav-history";
import { fmtDuration } from "@/lib/format";

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
};

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { jobs } = useJobs();
  const { t } = useI18n();
  const router = useRouter();
  const job = jobs.find((j) => j.id === id);
  // Hooks before the not-found early return; an unknown id just yields nulls.
  const { reportNum, entry } = useJobTiming(job ?? {});
  const subtitleIsNum = !!job?.subtitle && /^#\d+$/.test(job.subtitle);

  // ADR-0027 follow-up: runs dispatched outside this browser (API, another
  // tab) have no localStorage card — their record lives ONLY in the server
  // run ledger. When the id isn't local, fall back to the ledger so the
  // history page's detail links don't dead-end at "not in memory".
  const [ledgerEntry, setLedgerEntry] = useState<RunLedgerEntry | null>(null);
  const [ledgerLoaded, setLedgerLoaded] = useState(false);
  useEffect(() => {
    if (job) return; // local card wins — nothing to look up
    let alive = true;
    fetch("/api/runs/history")
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((d) => {
        if (!alive) return;
        setLedgerEntry((d.runs as RunLedgerEntry[]).find((r) => r.id === id) ?? null);
      })
      .catch(() => {})
      .finally(() => alive && setLedgerLoaded(true));
    return () => {
      alive = false;
    };
  }, [job, id]);

  if (!job && ledgerEntry) {
    // Terminal-only ledger view: the live step stream was never persisted, so
    // this renders the honest subset — status, title, duration, reason.
    const e = ledgerEntry;
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <button
          type="button"
          onClick={() => goBackOr(router, "/jobs")}
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
        >
          <ArrowLeft className="size-4" /> {t("shared.back")}
        </button>

        <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
          <div className="relative z-10">
            <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
              {e.status === "done" ? (
                <><Check className="size-3 text-emerald-500" /> {t("jobs.statusDone")}</>
              ) : (
                <><X className="size-3 text-red-400" /> {t("jobs.statusError")}</>
              )}
            </p>
            <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{e.title}</h1>
            <p className="mt-1 text-sm text-muted">
              {e.kind} · {t("jobs.ledgerInput")}: {e.input} · {fmtDuration(Math.round((e.finishedAt - e.startedAt) / 1000))}
            </p>
            {e.page && (
              <p className="mt-2">
                <Link href={e.page} className="text-sm text-brand transition-colors hover:underline">
                  {e.page}
                </Link>
              </p>
            )}
            {e.msg && (
              <p className="mt-3 rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm text-muted">{e.msg}</p>
            )}
          </div>
        </section>
        <p className="mt-4 text-xs text-faint">{t("jobs.ledgerNote")}</p>
      </div>
    );
  }

  if (!job && ledgerLoaded) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <button
          type="button"
          onClick={() => goBackOr(router, "/jobs")}
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
        >
          <ArrowLeft className="size-4" /> {t("shared.back")}
        </button>
        <p className="mt-8 text-sm text-muted">
          {t("jobs.notInMemory")}
        </p>
      </div>
    );
  }

  if (!job) {
    // Ledger fetch still in flight — keep the previous quiet placeholder so a
    // ledger-backed detail never flashes "not in memory" first.
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <button
          type="button"
          onClick={() => goBackOr(router, "/jobs")}
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
        >
          <ArrowLeft className="size-4" /> {t("shared.back")}
        </button>
        <p className="mt-8 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-3.5 animate-spin" /> {t("jobs.ledgerLoading")}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* 返回跟随会话历史（ADR-0019）；无应用内前一页时兜底回工作器列表——
          工作器详情页不是管道页，不固定回 /pipeline。 */}
      <button
        type="button"
        onClick={() => goBackOr(router, "/jobs")}
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
      >
        <ArrowLeft className="size-4" /> {t("shared.back")}
      </button>

      <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
        {job.status === "running" && <HeroGlow />}
        <div className="relative z-10">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
            {job.status === "running" ? (
              <><Loader2 className="size-3 animate-spin text-brand" /> {t("jobs.statusWorking")}</>
            ) : job.status === "queued" ? (
              <><Clock className="size-3 text-zinc-400" /> {t("jobs.queued")}{job.queuedPos != null ? ` · ${t("jobs.queuedPos", { n: job.queuedPos })}` : ""}</>
            ) : job.status === "done" ? (
              <><Check className="size-3 text-emerald-500" /> {t("jobs.statusDone")}</>
            ) : (
              <><X className="size-3 text-red-400" /> {t("jobs.statusError")}</>
            )}
          </p>
          <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">
            {job.title}
            {/* The report jump, exactly once: the /jobs rows carry it beside the
                title, and pool cards carry it AS the "#N" subtitle below — never
                both (ADR-0018). */}
            {reportNum && !subtitleIsNum && (
              <>
                {" "}
                <ReportNumLink
                  n={reportNum}
                  className="align-middle text-sm font-normal text-faint transition-colors hover:text-brand"
                />
              </>
            )}
          </h1>
          {subtitleIsNum && reportNum ? (
            <p className="mt-1 text-sm text-muted">
              <Link href={`/report/${reportNum}`} className="transition-colors hover:text-brand">
                {job.subtitle}
              </Link>
            </p>
          ) : (
            job.subtitle && <p className="mt-1 text-sm text-muted">{job.subtitle}</p>
          )}
          {job.result?.score != null && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Badge tone={job.result.tone}>{job.result.score}/5</Badge>
              {job.result.summary && <span className="text-sm text-muted">{job.result.summary}</span>}
            </div>
          )}
        </div>
      </section>

      <ol className="mt-6 space-y-2">
        {job.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            {s.kind === "tool" ? (
              <Wrench className="mt-0.5 size-3.5 shrink-0 text-brand" />
            ) : (
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-faint" />
            )}
            <span className={s.kind === "tool" ? "font-medium" : "text-muted"}>
              {s.kind === "tool" ? t("jobs.usingTool", { label: s.label }) : s.label}
            </span>
          </li>
        ))}
        {job.status === "running" && (
          <li className="flex items-center gap-2.5 text-sm text-muted">
            <Loader2 className="size-3.5 animate-spin text-brand" /> {t("jobs.thinking")}
          </li>
        )}
        {job.status === "queued" && (
          <li className="flex items-center gap-2.5 text-sm text-faint">
            <Clock className="size-3.5" /> {t("jobs.queuedHint")}
          </li>
        )}
      </ol>

      <EvalTimingPanel entry={entry} />

      {job.text && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{t("jobs.output")}</h2>
          <div className="report-prose mt-3 rounded-2xl border border-border bg-surface/40 p-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.text}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
