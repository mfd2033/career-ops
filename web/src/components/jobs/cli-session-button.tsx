"use client";

import { useRef, useState } from "react";
import { Check, SquareTerminal } from "lucide-react";
import type { Job } from "@/components/jobs/job-store";
import { useI18n } from "@/lib/i18n/context";
import { canResumeSession } from "@/lib/cli-session-shared.mjs";
import { cn } from "@/lib/cn";

// 「查看 CLI 会话」按钮（工作器终态卡）：点击后服务端开一个终端窗口，在该次
// headless run 的同一工作目录里恢复对应 CLI 会话（claude --resume / qoderclicn -r /
// opencode run -i -s，见 lib/cli-session.mjs 的单一事实源）。
//
// 自守卫口径与 canRetryJob 同风格（canViewSession）：非终态、无 sessionId（老任务
// /引擎没给）、引擎不支持恢复——一律渲染 null，无数据不占位。
//
// 权限提示必须跟着按钮走：交互式会话是全权限的，不受无头运行 per-kind 审计
// 权限（claude-invocation.mjs / qoder-invocation.mjs 的 deny 列表）约束——
// title 里明说这一点，呼应 clis.ts 头部的权限红线注释。

/** 按钮的自守卫判定；详情页与列表共用同一份口径。 */
export function canViewSession(job: Pick<Job, "sessionId" | "cliId" | "status">): boolean {
  return (
    (job.status === "done" || job.status === "error") &&
    !!job.sessionId &&
    !!job.cliId &&
    canResumeSession(job.cliId)
  );
}

export function CliSessionButton({
  job,
  withLabel = false,
  className,
}: {
  job: Pick<Job, "sessionId" | "cliId" | "status">;
  /** 详情页 = 带文字的常规按钮；/jobs 行与托盘 = 紧凑行外按钮。 */
  withLabel?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  // opened：POST 已被服务端接受（spawn 已发生，不代表窗口已聚焦——fire-and-forget
  // 契约与 /api/cv-pdf/open 同口径）。图标短暂变勾 2s，给一次可感知的回执。
  const [opened, setOpened] = useState(false);
  const busy = useRef(false);

  if (!canViewSession(job)) return null;
  const hint = t("jobs.viewSessionHint");

  const open = () => {
    if (busy.current) return;
    busy.current = true;
    fetch("/api/open-cli-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: job.sessionId, cliId: job.cliId }),
    })
      .then((r) => {
        if (r.ok) {
          setOpened(true);
          setTimeout(() => setOpened(false), 2000);
        }
      })
      .catch(() => {})
      .finally(() => {
        busy.current = false;
      });
  };

  return (
    <button
      type="button"
      onClick={(e) => {
        // 行内使用时外层可能是 Link——打开终端绝不触发导航。
        e.preventDefault();
        e.stopPropagation();
        open();
      }}
      title={hint}
      aria-label={t("jobs.viewSession")}
      className={cn(
        withLabel
          ? "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          : "flex items-center px-1.5 text-faint transition-colors hover:text-foreground",
        className,
      )}
    >
      {opened ? (
        <Check className={cn("shrink-0 text-emerald-500", withLabel ? "size-3.5" : "size-3.5")} />
      ) : (
        <SquareTerminal className="size-3.5 shrink-0" />
      )}
      {withLabel && <span>{t("jobs.viewSession")}</span>}
    </button>
  );
}
