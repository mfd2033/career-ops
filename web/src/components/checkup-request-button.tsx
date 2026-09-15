"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { checkupTone, type CheckupEntry } from "@/lib/format";
import { CHECKUP_RISK_LABELS } from "@/lib/company-checkups.mjs";
import type { CheckupTargetResult } from "@/lib/career-ops";
import { useJobs } from "@/components/jobs/job-store";
import { useI18n } from "@/lib/i18n/context";

// 形状单一来源是 career-ops.ts 的 findCheckupTarget（ReturnType 推导），
// 这里只是语义别名，避免两处手写漂移。
export type CheckupTarget = CheckupTargetResult;

// 「体检这家」（ADR-0027）: the press IS the user's confirmation — it
// pre-flights via POST /api/checkup-request (target + same-day dedup), then
// dispatches a kind=checkup WORKER through the global concurrency pool. The
// run is immediately visible on /jobs; the checkup writes HTML report + ledger
// row + report appendix, and never touches the offer score. With an existing
// checkup the button becomes 复检 (a NEW ledger row — history is the point).
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

  // Latest checkup worker for THIS row (the run's input is the tracker#).
  const job = jobs
    .filter((j) => j.kind === "checkup" && j.input === n)
    .sort((a, b) => b.startedAt - a.startedAt)[0];

  const trigger = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/checkup-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n }),
      });
      if (res.ok) {
        startJob({
          title: t("pipeline.checkupJobTitle", { company: target.ok ? target.company : `#${n}` }),
          subtitle: `#${n}`,
          kind: "checkup",
          input: n,
          page: `/pipeline/${n}`,
        });
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string; deduped?: boolean };
        setNote(
          j.deduped
            ? t("pipeline.checkupAlreadyQueued")
            : j.error === "no-via"
              ? t("pipeline.checkupNoVia")
              : t("pipeline.checkupFailed"),
        );
      }
    } catch {
      setNote(t("pipeline.checkupFailed"));
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

  return (
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
      {job?.status === "running" ? (
        <Link
          href={`/jobs/${job.id}`}
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand max-sm:min-h-[44px]"
        >
          <Loader2 className="size-3.5 animate-spin" /> {t("pipeline.checkupRunning")}
        </Link>
      ) : (
        <button
          onClick={trigger}
          disabled={busy}
          title={t("pipeline.checkupDispatchTitle")}
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px] disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          {checkup ? t("pipeline.checkupRecheck") : t("pipeline.checkup")}
        </button>
      )}
      {note && <span className="text-xs text-red-600 dark:text-red-400">{note}</span>}
    </span>
  );
}
