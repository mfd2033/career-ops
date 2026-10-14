"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { X, History } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { WorkerCard, pillTone, TONE } from "@/components/jobs/worker-card";
import { RetryJobButton } from "@/components/jobs/retry-job-button";
import { pickTrayJobs } from "@/lib/tray-jobs.mjs";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

// Back-compat re-exports (app/jobs/page.tsx imports pillTone from here).
export { pillTone, TONE };

// Collapsed "worker" pills in the sidebar — each the shared <WorkerCard> wrapped
// in a Link to its detail. Same component the assistant chat renders inline.
export function WorkerPills() {
  const { jobs, ledgerOnlyJobs, cancelJob, clearFinished } = useJobs();
  const pathname = usePathname();
  const { t } = useI18n();
  // 托盘合并纯台账卡：跨页签/扩展发起的终态任务以前只活在 /jobs 主列表，
  // 托盘彻底看不见。名额分配（进行中永不截断，终态新者优先）在
  // lib/tray-jobs.mjs；ledger-only 卡不挂 ✕（对台账行无效的死按钮）。
  const tray = pickTrayJobs(jobs, ledgerOnlyJobs, 6);
  if (tray.length === 0) return null;
  const running = tray.filter((j) => j.status === "running" || j.status === "queued").length;
  const finished = tray.length - running;

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
        {tray.map((j) => {
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
                    // 纯台账卡没有本地可删状态（✕ 点了台账行还在，下次轮询
                    // 又合并回来），不渲染；RetryJobButton 凭 canRetryJob 也自守卫
                    // 渲染 null。故 ledgerOnly 卡整个 trailing 不占位。
                    j.ledgerOnly ? undefined : (
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
                    )
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
