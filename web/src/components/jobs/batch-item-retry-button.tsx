"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { useI18n } from "@/lib/i18n/context";
import { canRetryBatchItem, hasLiveEvaluateForUrl } from "@/lib/batch-item-retry.mjs";
import type { JobItem } from "@/components/jobs/job-store";
import { cn } from "@/lib/cn";

// ADR-0093 决议 1/2/4：批量评估的终态失败子项 → 重试按钮。重试不是重跑父批量，
// 而是把这一条 URL 作为独立单任务 evaluate 工作器重新派发——父批量的失败证据
// 原样保留；同 URL 已有在跑的 evaluate 卡时只剩「重试中…」，防连点重复消费。
// checkup 子项（tracker# key）需要 /api/checkup-request 前哨，本组件由纯函数
// canRetryBatchItem 天然拦掉。
export function BatchItemRetryButton({
  item,
  cliId,
  model,
  className,
}: {
  item: JobItem;
  /** 父批量派发时的引擎快照——重试「原样再来」（ADR-0093 决议 3）。 */
  cliId?: string;
  model?: string;
  className?: string;
}) {
  const { jobs, startJob } = useJobs();
  const { t } = useI18n();
  if (!canRetryBatchItem(item)) return null;
  if (hasLiveEvaluateForUrl(jobs, item.key)) {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center gap-1 text-[11px] text-faint", className)}
        title={t("jobs.batchItemRetryRunning")}
      >
        <Loader2 className="size-3 animate-spin" /> {t("jobs.batchItemRetryRunning")}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        // 子项卡片未来若变可点（成功项才是 Link，本按钮只出现在失败项），
        // 重试绝不触发导航——与 RetryJobButton 同口径。
        e.preventDefault();
        e.stopPropagation();
        startJob({
          title: t("jobs.batchItemRetryTitle"),
          subtitle: item.key,
          kind: "evaluate",
          input: item.key,
          cliId,
          model,
        });
      }}
      title={t("jobs.batchItemRetryHint")}
      aria-label={t("jobs.batchItemRetry")}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-brand",
        className,
      )}
    >
      <RotateCcw className="size-3 shrink-0" /> {t("jobs.batchItemRetry")}
    </button>
  );
}