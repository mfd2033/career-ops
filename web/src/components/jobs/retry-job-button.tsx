"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useJobs, type Job } from "@/components/jobs/job-store";
import { useI18n } from "@/lib/i18n/context";
import { canRetryJob } from "@/lib/job-retry.mjs";
import { cn } from "@/lib/cn";

// ADR-0061 决议 1/6/7：error 卡的手动重试按钮（/jobs 行 + 详情页共用）。
// 单任务一键直达；批量（urls/ns 条数 > 1）先弹确认框，明示整卡重跑与条数
// （复用 ADR-0057 的内嵌弹窗模式，不用 window.confirm）。canRetryJob 不通过
// 的卡（取消/完成/池源/ledger-only）完全不渲染。
export function RetryJobButton({
  job,
  withLabel = false,
  className,
}: {
  job: Job;
  /** 详情页 = 带文字的常规按钮；/jobs 行 = chevron 同款的紧凑行外按钮。 */
  withLabel?: boolean;
  className?: string;
}) {
  const { retryJob } = useJobs();
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!canRetryJob(job)) return null;
  // 整卡重跑的条数：evaluate 批量看 urls，checkup 批量看 ns（二者互斥，与派发二分同口径）。
  const n = job.urls?.length ?? job.ns?.length ?? 0;
  const needsConfirm = n > 1;

  const requestRetry = () => {
    if (needsConfirm) setConfirmOpen(true);
    else retryJob(job.id);
  };

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // 行内使用时外层可能是 Link——重试绝不触发导航。
          e.preventDefault();
          e.stopPropagation();
          requestRetry();
        }}
        title={t("jobs.retry")}
        aria-label={t("jobs.retry")}
        className={cn(
          withLabel
            ? "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            : "flex items-center px-1.5 text-faint transition-colors hover:text-foreground",
          className,
        )}
      >
        <RotateCcw className="size-3.5 shrink-0" />
        {withLabel && <span>{t("jobs.retry")}</span>}
      </button>
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-xl">
            <h3 className="font-display text-base">{t("jobs.retryConfirmTitle")}</h3>
            <p className="mt-2 text-sm text-muted">{t("jobs.retryConfirmBody", { n })}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground"
              >
                {t("jobs.retryConfirmCancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  retryJob(job.id);
                }}
                className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200"
              >
                {t("jobs.retryConfirmConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
