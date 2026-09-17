"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, TriangleAlert } from "lucide-react";
import { CANONICAL_STATES } from "@/lib/format";
import { describeStatusWriteError, offlineStatusWriteError } from "@/lib/status-write-error.mjs";
import { useI18n } from "@/lib/i18n/context";

// Status writeback control. Updates the existing tracker row (status cell) via
// /api/status — never adds rows. Reverts on failure AND says why (ADR-0036): a
// silent revert left the user staring at a value they had just changed, with no
// way to tell a duplicated tracker number from a busy tracker lock.
export function StatusSelect({ n, current }: { n: string; current: string }) {
  const [status, setStatus] = useState(current);
  const [saved, setSaved] = useState(false);
  // Set only by a failed write; cleared when the user tries again (a fresh
  // failure replaces it), so the header never keeps a stale complaint.
  const [error, setError] = useState<{ key: string; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { t } = useI18n();

  async function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    const prev = status;
    setStatus(next);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, status: next }),
      });
      if (!res.ok) {
        // Revert, but never silently: `refresh()` is NOT called either — nothing
        // was written, and a refresh would only re-render the same row.
        setError(describeStatusWriteError(res.status, await res.json().catch(() => null)));
        setStatus(prev);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    } catch {
      setError(offlineStatusWriteError());
      setStatus(prev); // revert on failure
    } finally {
      setBusy(false);
    }
  }

  const known = (CANONICAL_STATES as readonly string[]).includes(status);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <label className="text-xs text-faint">{t("pipeline.statusLabel")}</label>
      <select
        value={status}
        onChange={onChange}
        disabled={busy}
        className="rounded-md border border-border bg-surface px-2.5 py-1 text-sm text-foreground outline-none transition-colors focus:border-brand/50 disabled:opacity-50 max-sm:min-h-[44px]"
      >
        {!known && <option value={status}>{status}</option>}
        {CANONICAL_STATES.map((s) => (
          <option key={s} value={s}>
            {t(`pipeline.status.${s.toLowerCase()}`)}
          </option>
        ))}
      </select>
      {saved && (
        <span className="animate-terminal-popup inline-flex items-center gap-1 text-xs font-medium text-brand">
          <Check className="size-3" /> {t("pipeline.saved")}
        </span>
      )}
      {/* basis-full: the reason goes on its own line under the control instead of
          squeezing the action row it sits in. */}
      {error && (
        <span className="inline-flex basis-full items-start gap-1 text-xs font-medium leading-snug text-red-600 dark:text-red-400" role="alert">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          {t(error.key, error.detail ? { detail: error.detail } : undefined)}
        </span>
      )}
    </span>
  );
}
