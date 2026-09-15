"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, ShieldCheck, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { checkupTone, type CheckupEntry } from "@/lib/format";
import { CHECKUP_RISK_LABELS } from "@/lib/company-checkups.mjs";
import { useI18n } from "@/lib/i18n/context";

export type CheckupTarget =
  | { ok: true; company: string; source: "company" | "via" }
  | { ok: false; reason: "row-not-found" | "no-via" };

// 「体检这家」（ADR-0026）: writes one intent into the agent inbox — the press
// IS the human confirmation; the checkup itself runs at the user's NEXT AI
// session (agent-inbox is async by design, so the UI says "queued", never
// "done"). With an existing checkup it shows ★ + risks + report link and the
// button becomes 复检 (re-check → a NEW ledger row; history is the point).
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
  const [state, setState] = useState<"idle" | "busy" | "queued" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);

  const trigger = async () => {
    setState("busy");
    setNote(null);
    try {
      const res = await fetch("/api/checkup-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n }),
      });
      if (res.ok) {
        setState("queued");
        return;
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string; deduped?: boolean };
      setState("error");
      setNote(j.deduped ? t("pipeline.checkupAlreadyQueued") : j.error === "no-via" ? t("pipeline.checkupNoVia") : t("pipeline.checkupFailed"));
    } catch {
      setState("error");
      setNote(t("pipeline.checkupFailed"));
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
      {state === "busy" ? (
        <button
          disabled
          className="inline-flex cursor-wait items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted max-sm:min-h-[44px]"
        >
          <Loader2 className="size-3.5 animate-spin" /> {t("pipeline.checkup")}…
        </button>
      ) : (
        <button
          onClick={trigger}
          title={t("pipeline.checkupQueuedTitle")}
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
        >
          <ShieldCheck className="size-3.5" /> {checkup ? t("pipeline.checkupRecheck") : t("pipeline.checkup")}
        </button>
      )}
      {state === "queued" && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t("pipeline.checkupQueued")}</span>}
      {state === "error" && note && <span className="text-xs text-red-600 dark:text-red-400">{note}</span>}
    </span>
  );
}
