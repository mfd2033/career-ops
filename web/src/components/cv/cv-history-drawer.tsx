"use client";

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { History, Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";

// 简历历史版本抽屉（ADR-0048 决议 3）。列表 = /api/cv/history（倒序快照），
// 预览 = /api/cv/history?ts=…（只读，历史不支持编辑）。还原动作由父组件
// 通过 onRestore 提供（工单 02：还原即生效，走现有保存路径）——本组件只
// 负责浏览与发起，不自己写盘。

export type CvSnapshot = { ts: string; bytes: number };

/** 时间戳 → 展示文本：本地时区 + 秒，如 2026-09-21 15:48:13。 */
function formatTs(ts: string): string {
  // 文件名时间戳是 UTC ISO 的连字符变体：还原成可解析形态再本地化
  const iso = ts.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1T$2:$3:$4.$5Z");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

export function CvHistoryDrawer({
  open,
  onClose,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  /** 工单 02 接线：把选中快照内容设为当前版本；未提供时不显示还原按钮。 */
  onRestore?: (content: string) => void;
}) {
  const { t } = useI18n();
  const [snaps, setSnaps] = useState<CvSnapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selTs, setSelTs] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  const loadList = useCallback(async () => {
    setLoaded(false);
    try {
      const res = await fetch("/api/cv/history");
      const data = await res.json();
      setSnaps(data.snapshots ?? []);
    } catch {
      setSnaps([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  // 每次打开都重新拉取：还原/保存后列表可能已变化
  useEffect(() => {
    if (open) void loadList();
  }, [open, loadList]);

  // 点选快照 → 拉取内容做只读预览；切换选择时清掉旧预览
  useEffect(() => {
    if (!selTs) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    setPreviewError(false);
    fetch(`/api/cv/history?ts=${encodeURIComponent(selTs)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (alive) setPreview(d.content ?? "");
      })
      .catch(() => {
        if (alive) setPreviewError(true);
      })
      .finally(() => {
        if (alive) setPreviewLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selTs]);

  return (
    <>
      {/* 遮罩层：点击关闭 */}
      {open && <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} aria-hidden />}
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-border bg-background shadow-xl transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full",
        )}
        aria-label={t("cv.history.title")}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="flex items-center gap-2 font-display text-lg tracking-tight">
            <History className="size-4 text-muted" />
            {t("cv.history.title")}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("cv.history.close")}>
            <X className="size-4" />
          </Button>
        </div>

        {!loaded ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" />
            {t("cv.history.loading")}
          </div>
        ) : snaps.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted">
            {t("cv.history.empty")}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* 左列：快照列表 */}
            <ul className="w-56 shrink-0 overflow-y-auto border-r border-border">
              {snaps.map((s) => (
                <li key={s.ts}>
                  <button
                    type="button"
                    onClick={() => setSelTs(s.ts)}
                    className={cn(
                      "w-full px-4 py-3 text-left transition-colors hover:bg-surface-hover",
                      selTs === s.ts && "bg-surface-hover",
                    )}
                  >
                    <div className="text-sm font-medium tabular-nums">{formatTs(s.ts)}</div>
                    <div className="mt-0.5 text-xs text-faint">{formatBytes(s.bytes)}</div>
                  </button>
                </li>
              ))}
            </ul>
            {/* 右侧：只读预览 */}
            <div className="min-w-0 flex-1 overflow-y-auto">
              {previewLoading ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              ) : previewError ? (
                <div className="p-5 text-sm text-muted">{t("cv.history.previewError")}</div>
              ) : preview !== null && selTs ? (
                <div className="flex h-full flex-col">
                  <article className="report-prose min-h-0 flex-1 overflow-y-auto p-5">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown>
                  </article>
                  {onRestore && (
                    <div className="border-t border-border p-4">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => {
                          if (preview === null) return;
                          setSelTs(null);
                          onRestore(preview);
                        }}
                      >
                        {t("cv.history.restore")}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-sm text-muted">
                  {t("cv.history.previewHere")}
                </div>
              )}
            </div>
          </div>
        )}

        <p className="border-t border-border px-5 py-3 text-xs text-faint">{t("cv.history.scope")}</p>
      </aside>
    </>
  );
}
