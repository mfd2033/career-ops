"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

// Soft skip: mark a scored-but-not-yet-decided application as Discarded — the
// same write as the "Skip" action on the Today page's "Awaiting your decision"
// block. This is the reversible alternative to DeleteFromTracker: the row stays
// in the tracker, just leaves the active queue. The write goes through the same
// core write-gate (/api/status → set-status.mjs) so status-log.tsv gets a row.
export function SkipFromTracker({ n }: { n: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function skip() {
    setBusy(true);
    try {
      // Same contract as the Today-page skip (decision-card): /api/status is the
      // core write-gate, the tracker row moves to Discarded. No res.ok check on
      // purpose — a rejected HTTP status still means set-status.mjs committed the
      // write, and landing on the Today page re-reads the tracker from disk so the
      // decision queue reflects the new state either way.
      await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, status: "Discarded" }),
      });
      router.push("/");
    } catch {
      /* ignore — status cell untouched on failure */
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={skip}
      title={t("pipeline.skipTitle")}
      className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-60 max-sm:min-h-[44px]"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />} {t("pipeline.skip")}
    </button>
  );
}
