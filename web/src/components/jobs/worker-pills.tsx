"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { X, History } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { WorkerCard, pillTone, TONE } from "@/components/jobs/worker-card";
import { RetryJobButton } from "@/components/jobs/retry-job-button";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

// Back-compat re-exports (app/jobs/page.tsx imports pillTone from here).
export { pillTone, TONE };

// Collapsed "worker" pills in the sidebar — each the shared <WorkerCard> wrapped
// in a Link to its detail. Same component the assistant chat renders inline.
export function WorkerPills() {
  const { jobs, cancelJob, clearFinished } = useJobs();
  const pathname = usePathname();
  const { t } = useI18n();
  if (jobs.length === 0) return null;
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued").length;
  const finished = jobs.length - running;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">{t("jobs.workers")}</span>
        {running > 0 && <span className="text-[10px] tabular-nums text-brand">{t("jobs.running", { n: running })}</span>}
        <Link href="/jobs" className="ml-auto text-faint transition-colors hover:text-foreground" title={t("jobs.historyTitle")} aria-label={t("jobs.historyAria")}>
          <History className="size-3.5" />
        </Link>
        {finished > 0 && (
          <button onClick={clearFinished} className="text-[10px] text-faint transition-colors hover:text-foreground" title={t("jobs.clearFinished")}>
            {t("jobs.clear")}
          </button>
        )}
      </div>
      <ul className="space-y-1.5">
        {jobs.slice(0, 6).map((j) => {
          const active = pathname === `/jobs/${j.id}`;
          return (
            <li key={j.id}>
              <Link
                href={`/jobs/${j.id}`}
                className={cn(
                  "group block rounded-lg border px-2.5 py-2 transition-colors",
                  active ? "border-brand/50 bg-brand-soft" : "border-border bg-surface/60 hover:bg-surface-hover",
                )}
              >
                <WorkerCard
                  job={j}
                  variant="tray"
                  trailing={
                    // ADR-0061：侧栏托盘与 /jobs 行、详情页同口径——error 卡除了
                    // 取消/忽略的 ✕，还要能一键重试。RetryJobButton 凭 canRetryJob
                    // 自守卫（非 error / 池源 / ledger-only 批量一律渲染 null），
                    // 故这里无条件挂上，只在可重试时占位。onClick 内部已 preventDefault
                    // 阻止外层 Link 跳详情。
                    <span className="flex items-center gap-0.5">
                      <RetryJobButton job={j} className="opacity-0 transition-opacity group-hover:opacity-100" />
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          cancelJob(j.id);
                        }}
                        className="text-faint opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                        title={j.status === "queued" || j.status === "running" ? t("jobs.cancelQueued") : t("jobs.dismissJob")}
                        aria-label={j.status === "queued" || j.status === "running" ? t("jobs.cancelQueued") : t("jobs.dismissJob")}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  }
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
