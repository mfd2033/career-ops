"use client";

import { useState } from "react";
import { Square } from "lucide-react";
import { useJobs, type Job } from "@/components/jobs/job-store";
import { useI18n } from "@/lib/i18n/context";
import { canStopJob } from "@/lib/job-stop.mjs";
import { cn } from "@/lib/cn";

// 工作器的「停止」入口（侧栏托盘 / /jobs 行 / 详情页共用）。
//
// 停止是破坏性动作，与「移除」严格分开：它中断执行并保留卡片，落
// 「已停止 · 用户中断」终态（仍可重试）。运行中的卡只给停止、不给移除；
// 终态卡反过来。canStopJob 自守卫（池源 running 批量卡没有服务端句柄，
// 不渲染入口），组件不通过时返回 null，无数据不占位。
export function StopJobButton({
  job,
  withLabel = false,
  className,
}: {
  job: Job;
  /** 详情页 = 带文字的常规按钮；托盘 / 行内 = 图标 + 小字「停止」。 */
  withLabel?: boolean;
  className?: string;
}) {
  const { cancelJob } = useJobs();
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!canStopJob(job)) return null;
  const queued = job.status === "queued";

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // 托盘与行内都嵌在外层 Link 里——停止绝不触发导航。
          e.preventDefault();
          e.stopPropagation();
          setConfirmOpen(true);
        }}
        title={t("jobs.stopJob")}
        aria-label={t("jobs.stopJob")}
        className={cn(
          withLabel
            ? "inline-flex items-center gap-1.5 rounded-md border border-red-500/35 bg-surface px-3 py-1.5 text-xs text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
            : "flex items-center gap-1 px-1.5 text-faint transition-colors hover:text-red-500",
          className,
        )}
      >
        <Square className="size-3 shrink-0 fill-current" />
        <span className={withLabel ? undefined : "text-[11px]"}>{t(withLabel ? "jobs.stopJob" : "jobs.stop")}</span>
      </button>
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-xl">
            <h3 className="font-display text-base">
              {t(queued ? "jobs.stopQueuedConfirmTitle" : "jobs.stopConfirmTitle")}
            </h3>
            <p className="mt-2 text-sm text-muted">
              {t(queued ? "jobs.stopQueuedConfirmBody" : "jobs.stopConfirmBody")}
            </p>
            <p className="mt-2 text-xs text-faint">
              {t(queued ? "jobs.stopQueuedConfirmAfter" : "jobs.stopConfirmAfter")}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground"
              >
                {t(queued ? "jobs.stopQueuedConfirmCancel" : "jobs.stopConfirmCancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  cancelJob(job.id);
                }}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700"
              >
                {t(queued ? "jobs.stopQueuedConfirmConfirm" : "jobs.stopConfirmConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}