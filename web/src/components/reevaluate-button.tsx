"use client";

import { useEffect, useMemo } from "react";
import { Loader2, RotateCcw, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";
import { useI18n } from "@/lib/i18n/context";

// Re-runs the REAL career-ops evaluation for THIS posting (worker kind
// "evaluate" → modes/oferta.md → a fresh report + the tracker row updated via
// merge-tracker's URL dedup). It's the same engine QuickEvaluate fires, scoped
// to the report already open, so re-running with a changed CV/profile yields an
// updated score without a new posting URL.
export function ReevaluateButton({ id, url, company }: { id: string; url?: string; company: string }) {
  const { jobs, startJob } = useJobs();
  const { t } = useI18n();
  const router = useRouter();
  const job = useMemo(
    () => jobs.filter((j) => j.kind === "evaluate" && j.input === url).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, url],
  );

  // When the worker finishes, the tracker row / report has changed on disk —
  // refresh the server component so the new score, status and report body show.
  useEffect(() => {
    if (!url) return;
    const onDone = (e: Event) => {
      const detail = (e as CustomEvent).detail as { kind?: string; input?: string } | undefined;
      if (detail?.kind === "evaluate" && detail.input === url) router.refresh();
    };
    window.addEventListener("co-job-done", onDone);
    return () => window.removeEventListener("co-job-done", onDone);
  }, [url, router]);

  const trigger = () => {
    if (!url) return;
    startJob({ title: t("pipeline.reevaluateTitle", { company }), subtitle: t("pipeline.reevaluateSubtitle"), kind: "evaluate", input: url, page: `/pipeline/${id}` });
  };

  if (!url)
    return (
      <span className="inline-flex items-center gap-1.5">
        <button
          disabled
          title={t("pipeline.reevaluateNoUrl")}
          className="inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-full border border-border/50 px-3 py-1 text-xs font-medium text-faint opacity-60 max-sm:min-h-[44px]"
        >
          <RefreshCw className="size-3.5" /> {t("pipeline.reevaluate")}
        </button>
      </span>
    );

  if (job?.status === "running")
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand max-sm:min-h-[44px]">
        <Loader2 className="size-3.5 animate-spin" /> {t("pipeline.reevaluating")}
      </Link>
    );

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={trigger}
        title={t("pipeline.reevaluateTitle", { company })}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
      >
        <RotateCcw className="size-3.5" /> {t("pipeline.reevaluate")}
      </button>
      <CostBadge kind="spend" size="xs" />
    </span>
  );
}
