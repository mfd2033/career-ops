"use client";

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, History, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { CvHistoryDrawer } from "@/components/cv/cv-history-drawer";

export function CvEditor() {
  const { t } = useI18n();
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [exists, setExists] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // 历史版本（ADR-0048）：入口徽标份数 / 抽屉开关 / 待还原内容（确认框挂起）
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snapCount, setSnapCount] = useState(0);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);
  const [restoreError, setRestoreError] = useState(false);

  // 快照份数徽标：页面加载、保存/还原后各刷一次（轻量目录列表）
  const refreshSnapCount = useCallback(() => {
    fetch("/api/cv/history")
      .then((r) => r.json())
      .then((d) => setSnapCount(d.snapshots?.length ?? 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/cv")
      .then((r) => r.json())
      .then((d) => {
        setContent(d.content ?? "");
        setExists(d.exists ?? false);
      })
      .finally(() => {
        setLoaded(true);
        refreshSnapCount();
      });
  }, [refreshSnapCount]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        setDirty(false);
        setExists(true);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        refreshSnapCount();
      }
    } finally {
      setSaving(false);
    }
  }

  // 还原即生效（ADR-0048 决议 4）：抽屉发来的快照内容先过确认框；
  // 确认后走与保存完全相同的 POST /api/cv——当前版本因此先被快照进
  // 历史（可逆），后端零新增写路径。
  async function confirmRestore() {
    if (pendingRestore === null) return;
    setRestoring(true);
    setRestoreError(false);
    try {
      const res = await fetch("/api/cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: pendingRestore }),
      });
      if (!res.ok) {
        setRestoreError(true);
        return;
      }
      setContent(pendingRestore);
      setDirty(false);
      setExists(true);
      setHistoryOpen(false);
      setPendingRestore(null);
      setRestored(true);
      setTimeout(() => setRestored(false), 2000);
      refreshSnapCount();
    } catch {
      setRestoreError(true);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">{t("cv.editor.title")}</h1>
          <p className="mt-1 text-sm text-muted">
            {t("cv.editor.introEdit")} <code className="text-foreground">cv.md</code> {t("cv.editor.introPreview")}
            {!exists && loaded && <span className="ml-1 text-faint">{t("cv.editor.noCvYet")}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {restored && <span className="text-sm text-muted">{t("cv.history.restored")}</span>}
          {/* 历史版本入口：徽标显示现存份数（0 份也可见——空态文案引导） */}
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-hover max-sm:min-h-[44px]"
          >
            <History className="size-4" />
            {t("cv.history.button")}
            {snapCount > 0 && (
              <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-brand">
                {snapCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className={cn(
              "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors max-sm:min-h-[44px]",
              dirty
                ? "bg-brand text-brand-foreground hover:bg-brand-200"
                : "border border-border bg-surface text-muted",
            )}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : saved ? <Check className="size-4" /> : null}
            {saved ? t("cv.editor.saved") : t("cv.editor.save")}
          </button>
        </div>
      </div>

      {!loaded ? (
        <div className="mt-6 text-sm text-muted">{t("cv.editor.loading")}</div>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            placeholder={t("cv.editor.placeholder")}
            className="min-h-[60vh] w-full resize-none rounded-2xl border border-border bg-surface/50 p-4 font-mono text-sm leading-relaxed outline-none transition-colors placeholder:text-faint focus:border-brand/40"
          />
          <article className="report-prose min-h-[60vh] overflow-auto rounded-2xl border border-border bg-surface/30 p-5">
            {content.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            ) : (
              <p className="text-muted">{t("cv.editor.previewHere")}</p>
            )}
          </article>
        </div>
      )}

      <CvHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestore={(c) => setPendingRestore(c)}
      />

      {/* 还原二次确认框：dirty 时追加未保存警告（ADR-0048 决议 4） */}
      {pendingRestore !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" role="dialog" aria-modal>
          <div className="absolute inset-0 bg-black/40" onClick={() => !restoring && setPendingRestore(null)} aria-hidden />
          <div className="relative w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-xl">
            <h3 className="font-display text-lg tracking-tight">{t("cv.history.confirmTitle")}</h3>
            <p className="mt-2 text-sm text-muted">{t("cv.history.confirmBody")}</p>
            {dirty && (
              <p className="mt-2 rounded-lg bg-surface p-3 text-sm text-muted">{t("cv.history.confirmDirty")}</p>
            )}
            {restoreError && <p className="mt-2 text-sm text-red-500">{t("cv.history.restoreError")}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={restoring} onClick={() => setPendingRestore(null)}>
                {t("cv.history.cancel")}
              </Button>
              <Button variant="primary" size="sm" disabled={restoring} onClick={confirmRestore}>
                {restoring ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("cv.history.confirm")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
