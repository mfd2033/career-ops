"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { skipDestination } from "@/lib/skip-destination.mjs";

// Soft skip: mark a scored-but-not-yet-decided application as Discarded — the
// same write as the "Skip" action on the Today page's "Awaiting your decision"
// block. This is the reversible alternative to DeleteFromTracker: the row stays
// in the tracker, just leaves the active queue. The write goes through the same
// core write-gate (/api/status → set-status.mjs) so status-log.tsv gets a row.
//
// 写盘后前进（不再是回首页）：落点由 skip-destination.mjs 决定——有下一份 replace
// 到下一份，没有 replace 回列表页；深链页（无列表上下文）维持旧行为 push 回首页。
export function SkipFromTracker({
  n,
  nextHref,
  fallbackHref,
  hasListContext,
}: {
  n: string;
  nextHref: string | null;
  fallbackHref: string;
  hasListContext: boolean;
}) {
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
      // 落点三档（skip-destination.mjs，node --test 锁定）：有下一份 → replace
      // 到下一份；没有 → replace 回列表页（保留 tab/排序/搜索上下文）；深链页
      // （无列表上下文）维持旧行为 push 回首页。replace 让被跳过的这份不进返回
      // 栈，连跳多份后「返回」直接回列表——与右上角 prev/next 的 push 浏览语义
      // 有意不同构。不看 res.ok——契约与今日页跳过一致，失败自愈。
      const dest = skipDestination({ nextHref, fallbackHref, hasListContext });
      if (dest.replace) router.replace(dest.href);
      else router.push(dest.href);
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
