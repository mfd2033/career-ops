"use client";

import { useRef, useState } from "react";
import { Check, SquareTerminal } from "lucide-react";
import type { Job } from "@/components/jobs/job-store";
import { useI18n } from "@/lib/i18n/context";
import { canViewSession as canViewSessionFor } from "@/lib/cli-session-shared.mjs";
import { cn } from "@/lib/cn";

// 「查看 CLI 会话」按钮（工作器卡）：点击后服务端开一个终端窗口，在该次 headless
// run 的同一工作目录里恢复对应 CLI 会话（claude --resume / qoderclicn -r /
// opencode --session，见 lib/cli-session.mjs 的单一事实源）。
//
// 自守卫口径见 lib/cli-session-shared.mjs 的 canViewSession（纯逻辑，单测覆盖）：
// 排队中 / 引擎不支持 / 无会话线索一律渲染 null，无数据不占位。运行中的卡片也
// 给入口——claude/qoder-cn 的 init 帧一到就有 id，opencode 则靠服务端凭 runId
// 现场反查（派发时埋的 `--title career-ops-<runId>`）。
//
// 权限提示必须跟着按钮走：交互式会话是全权限的，不受无头运行 per-kind 审计
// 权限（claude-invocation.mjs / qoder-invocation.mjs 的 deny 列表）约束——
// title 里明说这一点，呼应 clis.ts 头部的权限红线注释。
//
// 并发写：运行中恢复 = 交互终端与 headless 进程同时写同一份会话，行为上允许
// （用户 2026-11-09 确认接受该风险），不在这里加二次确认。

/** 按钮的自守卫判定；详情页与列表共用同一份口径（实现在 shared，可被单测覆盖）。 */
export function canViewSession(job: Pick<Job, "sessionId" | "cliId" | "status" | "runId">): boolean {
  return canViewSessionFor(job);
}

/** 会话尚未建出来时（开跑头几秒 / 引擎没给）后端的 404 回应码。 */
const NOT_READY_STATUS = 404;

export function CliSessionButton({
  job,
  withLabel = false,
  className,
}: {
  job: Pick<Job, "sessionId" | "cliId" | "status" | "runId">;
  /** 详情页 = 带文字的常规按钮；/jobs 行与托盘 = 紧凑行外按钮。 */
  withLabel?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  // opened：POST 已被服务端接受（spawn 已发生，不代表窗口已聚焦——fire-and-forget
  // 契约与 /api/cv-pdf/open 同口径）。图标短暂变勾 2s，给一次可感知的回执。
  const [opened, setOpened] = useState(false);
  // notReady：会话还没建出来（运行中头几秒最常见）。图标短暂变红 + 提示，同样是
  // 2s 回执，不弹窗、不打断。
  const [notReady, setNotReady] = useState(false);
  const busy = useRef(false);

  if (!canViewSession(job)) return null;
  const hint = t("jobs.viewSessionHint");

  const open = () => {
    if (busy.current) return;
    busy.current = true;
    fetch("/api/open-cli-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // sessionId 缺失时带 runId，由服务端给自己解析（仅 opencode 支持）。
      body: JSON.stringify({ sessionId: job.sessionId, cliId: job.cliId, runId: job.runId }),
    })
      .then((r) => {
        if (r.ok) {
          setOpened(true);
          setTimeout(() => setOpened(false), 2000);
          return;
        }
        if (r.status === NOT_READY_STATUS) {
          setNotReady(true);
          setTimeout(() => setNotReady(false), 2000);
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
      title={notReady ? t("jobs.viewSessionNotReady") : hint}
      aria-label={t("jobs.viewSession")}
      className={cn(
        withLabel
          ? "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          : "flex items-center px-1.5 text-faint transition-colors hover:text-foreground",
        className,
      )}
    >
      {opened ? (
        <Check className="size-3.5 shrink-0 text-emerald-500" />
      ) : (
        <SquareTerminal className={cn("size-3.5 shrink-0", notReady && "text-red-400")} />
      )}
      {withLabel && <span>{notReady ? t("jobs.viewSessionNotReady") : t("jobs.viewSession")}</span>}
    </button>
  );
}
