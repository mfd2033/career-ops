"use client";

import { useCallback, useEffect, useState } from "react";
import { History, Loader2, X } from "lucide-react";
import { CANONICAL_STATES } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";

// 状态变化记录（status history）：紧邻状态选择框的一枚按钮，弹窗列出这一行在
// data/status-log.tsv 里的全部转换（set-status.mjs / /api/status 每写一次追加
// 一行）。只读——数据按需从 /api/status-log 拉，不参与任何写盘路径。
type StatusEvent = { date: string; from: string; to: string; source: string; note: string };

export function StatusHistoryButton({ n }: { n: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<StatusEvent[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/status-log?n=${encodeURIComponent(n)}`);
      if (!res.ok) throw new Error("failed");
      const j = (await res.json()) as { events?: StatusEvent[] };
      setEvents(Array.isArray(j.events) ? j.events : []);
    } catch {
      setError(true);
      setEvents(null);
    } finally {
      setLoading(false);
    }
  }, [n]);

  // 每次打开都重新拉：状态选择框可能刚写过一行新记录，弹窗应看到最新的。
  useEffect(() => {
    if (!open) return;
    void load();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, load]);

  // 转换哨兵 `-`（from/to 未知）显示为破折号；规范化状态走 i18n 显示名，未知值
  // 原样保留（数据值永远是英文规范值）。
  const statusLabel = (s: string) => {
    if (!s || s === "-") return "—";
    return (CANONICAL_STATES as readonly string[]).includes(s)
      ? t(`pipeline.status.${s.toLowerCase()}`)
      : s;
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("pipeline.statusHistoryTitle")}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
      >
        <History className="size-3.5" /> {t("pipeline.statusHistory")}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("pipeline.statusHistoryAria")}
            className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-4">
              <h2 className="font-display text-lg">{t("pipeline.statusHistory")}</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("pipeline.statusHistoryClose")}
                className="rounded p-1 text-faint transition hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mt-4">
              {loading && (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="size-3.5 animate-spin" /> {t("pipeline.statusHistoryLoading")}
                </p>
              )}
              {!loading && error && <p className="text-sm text-red-500">{t("pipeline.statusHistoryError")}</p>}
              {!loading && !error && events && events.length === 0 && (
                <p className="text-sm text-muted">{t("pipeline.statusHistoryEmpty")}</p>
              )}
              {!loading && !error && events && events.length > 0 && (
                <ul className="space-y-2">
                  {events.map((ev, i) => (
                    <li key={`${ev.date}-${i}`} className="rounded-lg border border-border/60 bg-surface/40 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="font-mono text-xs text-faint">{ev.date}</span>
                        <span className="font-medium">
                          {statusLabel(ev.from)} → {statusLabel(ev.to)}
                        </span>
                        {ev.source && (
                          <span className="text-xs text-faint">
                            {t("pipeline.statusHistoryVia", { source: ev.source })}
                          </span>
                        )}
                      </div>
                      {ev.note && <p className="mt-1 text-xs text-muted">{ev.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}