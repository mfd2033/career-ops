"use client";

import { useState } from "react";
import Link from "next/link";
import { Clock, ExternalLink, Loader2, RotateCcw, ShieldCheck, Square, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { checkupTone, type CheckupEntry } from "@/lib/format";
import { CHECKUP_RISK_LABELS } from "@/lib/company-checkups.mjs";
import type { CheckupTargetResult } from "@/lib/career-ops";
import { useJobs } from "@/components/jobs/job-store";
import { useI18n } from "@/lib/i18n/context";

// 形状单一来源是 career-ops.ts 的 findCheckupTarget（ReturnType 推导），
// 这里只是语义别名，避免两处手写漂移。
export type CheckupTarget = CheckupTargetResult;

/** 前哨（/api/checkup-request）报告的在跑体检 —— 「停止」靠它给的 runId，跨标签页/
 *  跨浏览器也成立（那时本页没有那张工作器卡片）。 */
type RunningCheckup = { runId: string; state: string; startedAt: number | null };

// 「体检这家」（ADR-0027，重复与替换语义见 ADR-0033）: the press IS the user's
// confirmation — it pre-flights via POST /api/checkup-request, then dispatches a
// kind=checkup WORKER through the global concurrency pool. The run is immediately
// visible on /jobs; the checkup writes HTML report + ledger row + report appendix,
// and never touches the offer score. With an existing checkup the button becomes
// 复检 (a NEW ledger row — history is the point).
//
// ADR-0033 改了两件事：同日去重废止（当天再按不再被挡），以及体检进行中不再把按钮
// 整只藏起来——chip 照旧指向 /jobs，旁边按钮照样可点；按下由前哨答「本行已在体检」
// 时就地展开面板，由用户裁决「停止」（杀进程，产物不回滚）或「停止并重新体检」
// （替换：先停旧的、确认它真的退出，再派新的）。
export function CheckupRequestButton({
  n,
  checkup,
  target,
}: {
  n: string;
  checkup: CheckupEntry | null;
  target: CheckupTarget;
}) {
  const { t } = useI18n();
  const { jobs, startJob } = useJobs();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [panel, setPanel] = useState<RunningCheckup[] | null>(null);

  // Latest checkup worker for THIS row (the run's input is the tracker#). 只驱动 chip
  // 与面板里的 /jobs 链接；判「在不在跑」的权威是服务端登记表（ADR-0033 决议 2/7）。
  const job = jobs
    .filter((j) => j.kind === "checkup" && j.input === n)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const jobLive = job?.status === "running" || job?.status === "queued";

  const trigger = async (replace: boolean) => {
    setBusy(true);
    setNote(null);
    setWarn(null);
    try {
      const res = await fetch("/api/checkup-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(replace ? { n, replace: true } : { n }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        running?: RunningCheckup[];
        unconfirmed?: boolean;
      };
      if (res.ok) {
        setPanel(null);
        if (j.unconfirmed) setWarn(t("pipeline.checkupPanelUnconfirmed"));
        startJob({
          title: t("pipeline.checkupJobTitle", { company: target.ok ? target.company : `#${n}` }),
          subtitle: `#${n}`,
          kind: "checkup",
          input: n,
          page: `/pipeline/${n}`,
        });
      } else if (res.status === 409 && Array.isArray(j.running)) {
        // 在跑：服务端说了才算（跨标签页/跨浏览器也拦得住）。就地展开面板，
        // 让用户裁决——不再是一句「今天已派发过」的死胡同。
        setPanel(j.running);
      } else {
        setNote(
          j.error === "no-via"
            ? t("pipeline.checkupNoVia")
            : j.error === "row-not-found"
              ? t("pipeline.checkupNoRow")
              : t("pipeline.checkupFailed"),
        );
      }
    } catch {
      setNote(t("pipeline.checkupFailed"));
    } finally {
      setBusy(false);
    }
  };

  // 「停止」= 硬停（ADR-0033 决议 5）：走现成的 /api/run/cancel → 杀进程树、账本记
  // error「cancelled by user」。用前哨给的 runId，所以跨会话也停得掉；本页若有那张
  // 卡片，它会被 /api/events 的 error 终态改成「已取消」并留在托盘（决议 5）。
  const stop = async (thenRecheck: boolean) => {
    const runIds = (panel ?? []).map((r) => r.runId);
    setBusy(true);
    setNote(null);
    setWarn(null);
    try {
      const stopped = await Promise.all(
        runIds.map((runId) =>
          fetch("/api/run/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId }),
          })
            .then((r) => r.ok)
            .catch(() => false),
        ),
      );
      if (runIds.length > 0 && !stopped.some(Boolean)) {
        // 一条都没停成（run 已自行结束的情形由服务端当已停处理，不该走到这里）。
        setNote(t("pipeline.checkupStopFailed"));
        return;
      }
      if (thenRecheck) {
        setPanel(null);
        await trigger(true); // 替换：前哨先停掉同 tracker# 全部在跑，确认退出后才放行
        return;
      }
      setPanel(null);
      setNote(t("pipeline.checkupStopped"));
    } finally {
      setBusy(false);
    }
  };

  const risksTitle = checkup
    ? [
        t("pipeline.checkupLatest", { star: checkup.star.toFixed(1), date: checkup.date }),
        checkup.risks.map((r) => (CHECKUP_RISK_LABELS as Record<string, string>)[r] ?? r).join(" / "),
        checkup.count > 1 ? `${checkup.count}×` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  // Disabled states — always with a visible reason (ADR-0026 决议 6).
  if (!target.ok) {
    const reason = target.reason === "no-via" ? t("pipeline.checkupNoVia") : t("pipeline.checkupNoRow");
    return (
      <span className="inline-flex items-center gap-1.5" title={reason}>
        <button
          disabled
          className="inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-full border border-border/50 px-3 py-1 text-xs font-medium text-faint opacity-60 max-sm:min-h-[44px]"
        >
          <ShieldCheck className="size-3.5" /> {t("pipeline.checkup")}
        </button>
      </span>
    );
  }

  // 在跑（或刚被取消）：面板里的状态文案取最新那条。多条只在极端并发下出现，两个
  // 动作都作用于同 tracker# 的全部在跑体检（ADR-0033 决议 3）。
  const primary = panel && panel.length > 0 ? panel[panel.length - 1] : null;
  const elapsedMin = primary?.startedAt ? Math.max(1, Math.round((Date.now() - primary.startedAt) / 60000)) : null;

  return (
    <>
      <span className="inline-flex items-center gap-2">
        {checkup && (
          <span className="inline-flex items-center gap-1.5" title={risksTitle ?? undefined}>
            <Badge tone={checkupTone(checkup.star)}>★{checkup.star.toFixed(1)}</Badge>
            {checkup.html !== "-" && (
              <Link
                href={`/api/checkup-report?n=${n}`}
                target="_blank"
                className="inline-flex items-center gap-0.5 text-xs text-muted underline-offset-2 transition-colors hover:text-brand hover:underline"
              >
                {t("pipeline.checkupReport")} <ExternalLink className="size-3" />
              </Link>
            )}
          </span>
        )}
        {jobLive && job && (
          <Link
            href={`/jobs/${job.id}`}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand max-sm:min-h-[44px]"
          >
            {job.status === "queued" ? (
              <>
                <Clock className="size-3.5" /> {t("pipeline.checkupQueued")}
              </>
            ) : (
              <>
                <Loader2 className="size-3.5 animate-spin" /> {t("pipeline.checkupRunning")}
              </>
            )}
          </Link>
        )}
        <button
          onClick={() => trigger(false)}
          disabled={busy}
          title={t("pipeline.checkupDispatchTitle")}
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px] disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          {checkup ? t("pipeline.checkupRecheck") : t("pipeline.checkup")}
        </button>
        {note && <span className="text-xs text-red-600 dark:text-red-400">{note}</span>}
        {warn && <span className="text-xs text-amber-600 dark:text-amber-400">{warn}</span>}
      </span>

      {/* 就地内联面板（house pattern：delete-from-tracker）—— 在操作区的 flex-wrap
          里 w-full 会独占一行。 */}
      {panel && (
        <div className="w-full rounded-lg border border-border bg-surface/60 p-3 text-xs">
          <p className="font-medium text-foreground">
            {primary && primary.state === "queued"
              ? t("pipeline.checkupPanelQueued")
              : t("pipeline.checkupPanelRunning", { min: String(elapsedMin ?? 1) })}
          </p>
          <p className="mt-1 text-muted">{t("pipeline.checkupPanelNoRollback")}</p>
          {job && jobLive && (
            <p className="mt-1">
              <Link href={`/jobs/${job.id}`} className="text-brand hover:underline">
                {t("pipeline.checkupPanelOpenJob")}
              </Link>
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              disabled={busy}
              onClick={() => stop(false)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-medium text-muted transition-colors hover:border-red-400/50 hover:text-red-500 max-sm:min-h-[44px] disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />} {t("pipeline.checkupPanelStop")}
            </button>
            <button
              disabled={busy}
              onClick={() => stop(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand-soft px-2.5 py-1 font-medium text-brand transition-colors hover:border-brand/60 max-sm:min-h-[44px] disabled:opacity-50"
            >
              <RotateCcw className="size-3.5" /> {t("pipeline.checkupPanelReplace")}
            </button>
            <button
              disabled={busy}
              onClick={() => setPanel(null)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-muted transition-colors hover:text-foreground max-sm:min-h-[44px] disabled:opacity-50"
            >
              <X className="size-3.5" /> {t("pipeline.checkupPanelDismiss")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
