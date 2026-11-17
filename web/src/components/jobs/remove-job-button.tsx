"use client";

import { X } from "lucide-react";
import { useJobs, type Job } from "@/components/jobs/job-store";
import { useI18n } from "@/lib/i18n/context";
import { canRemoveJob } from "@/lib/job-stop.mjs";
import { cn } from "@/lib/cn";

// 终态卡的「移除」入口（侧栏托盘 + /jobs 行共用）。
//
// 只是从列表拿掉卡片，不改变任何执行结果——运行中的卡根本走不到这里
// （canRemoveJob 只放行 done/error），要中断请用 StopJobButton。纯台账卡
// 不渲染：它不是本地状态，删了下一轮又被台账合并回来。
export function RemoveJobButton({ job, className }: { job: Job; className?: string }) {
  const { removeJob } = useJobs();
  const { t } = useI18n();
  if (!canRemoveJob(job)) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        // 外层是 Link（托盘卡、/jobs 列表行）——移除绝不触发导航。
        e.preventDefault();
        e.stopPropagation();
        removeJob(job.id);
      }}
      title={t("jobs.removeJob")}
      aria-label={t("jobs.removeJob")}
      className={cn("flex items-center px-1.5 text-faint transition-colors hover:text-foreground", className)}
    >
      <X className="size-3.5 shrink-0" />
    </button>
  );
}