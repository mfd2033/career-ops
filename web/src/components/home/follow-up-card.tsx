"use client";

import { useState } from "react";
import { BellOff, Check, Clock, FileText, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { CompanyLogo } from "@/components/company-logo";
import { LogFollowupButton } from "@/components/followups/log-followup-button";
import type { CadenceEntry } from "@/lib/followups";
import { useI18n } from "@/lib/i18n/context";

// One-tap overdue follow-up row (demand loop). "Mark followed up" appends a
// table row to data/follow-ups.md (append-only) so the core cadence advances;
// "Snooze" is a client dismiss. The cadence is the core's — we just surface + record.
// followup 直接用 /api/followups 的完整 CadenceEntry：「记录跟进」弹窗（报告页
// 同一枚 LogDialog）需要 contacts / followups 等全量字段，首页本来就拿得到。
export function FollowUpCard({ followup, onLogged }: { followup: CadenceEntry; onLogged?: () => void }) {
  const [state, setState] = useState<"idle" | "logging" | "done" | "snoozed" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const { t } = useI18n();
  if (state === "snoozed" || state === "done") return null;

  // 四个操作统一为图标按钮（原型 2026-11-09）：定尺寸、hover 变色不改布局，
  // 名称走 title/aria-label；窄屏放大触控区到 44px。
  const iconCls =
    "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-brand-soft hover:text-brand max-sm:min-h-[44px] max-sm:min-w-[44px]";

  const log = async () => {
    setState("logging");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/followups/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appNum: followup.num,
          company: followup.company,
          role: followup.role,
          channel: "Other",
          notes: "Followed up",
        }),
      });
      // A 4xx/5xx means nothing was written — showing "done" would silently
      // drop the log and the nag would just come back next visit. Surface the
      // server's error detail so a validation reject reads differently from a
      // transient failure (same j.error contract as next-date-dialog).
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
        setState("error"); // keep the row visible so the user can retry
        return;
      }
      onLogged?.();
      setState("done");
    } catch {
      setState("error"); // keep the row visible so the user can retry
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface/40 px-3.5 py-3 transition hover:border-brand/30">
      <div className="flex min-w-0 flex-[1_1_55%] items-center gap-3">
        <CompanyLogo name={followup.company} size={22} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            <span className="font-medium text-foreground">{followup.company}</span>
            {followup.role && <span className="text-muted"> · {followup.role}</span>}
          </p>
          <p className="flex items-center gap-1 text-[11px] text-faint">
            <Clock className="size-3" /> {followup.appliedDate ? t("home.appliedOn", { date: followup.appliedDate }) : t("home.followUpDue")}
          </p>
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* 「记录跟进」（报告页同款弹窗）：记录成功后通知父级刷新待跟进列表 */}
        <LogFollowupButton entry={followup} iconOnly onLogged={() => onLogged?.()} />
        <button
          type="button"
          disabled={state === "logging"}
          onClick={log}
          title={state === "error" && errorMsg ? errorMsg : t("home.markFollowedUp")}
          aria-label={state === "error" && errorMsg ? errorMsg : t("home.markFollowedUp")}
          className={cn(
            iconCls,
            "bg-surface-hover hover:bg-brand-soft",
            state === "error" && "text-red-500 hover:text-red-400",
          )}
        >
          {state === "logging" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        </button>
        {followup.num != null && (
          <a href={`/pipeline/${followup.num}`} title={t("home.openReport")} aria-label={t("home.openReport")} className={iconCls}>
            <FileText className="size-4" />
          </a>
        )}
        <button type="button" onClick={() => setState("snoozed")} title={t("home.snooze")} aria-label={t("home.snooze")} className={iconCls}>
          <BellOff className="size-4" />
        </button>
      </div>
    </div>
  );
}
