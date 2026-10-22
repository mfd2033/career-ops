"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Check, History, Loader2, Upload } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { CvHistoryDrawer } from "@/components/cv/cv-history-drawer";
import { readMarkdownCv, type CvImportError } from "@/lib/cv/import";

// 导入失败原因 → i18n 键（渲染时才翻译，与语种切换保持一致）
const IMPORT_ERROR_KEY: Record<CvImportError, string> = {
  ext: "cv.import.errExt",
  empty: "cv.import.errEmpty",
  "too-large": "cv.import.errTooLarge",
  read: "cv.import.errRead",
};

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

  // Markdown 简历导入：选文件 → 覆盖前确认 → 填入编辑器。保存仍走 POST /api/cv，
  // 与「还原历史版本」同一条可逆路径（旧 cv.md 先被快照）。
  const [pendingImport, setPendingImport] = useState<{ name: string; content: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<CvImportError | null>(null);
  const [imported, setImported] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

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

  // 选中的文件先过校验与归一化；编辑器已有内容就弹确认框，空编辑器直接填入。
  async function pickFile(file: File) {
    setImporting(true);
    setImportError(null);
    try {
      const res = await readMarkdownCv(file);
      if (!res.ok) {
        setImportError(res.reason);
        return;
      }
      if (content.trim()) {
        setPendingImport({ name: file.name, content: res.content });
        return;
      }
      applyImport(res.content);
    } finally {
      setImporting(false);
    }
  }

  function applyImport(text: string) {
    setContent(text);
    setDirty(true);
    setPendingImport(null);
    setImportError(null);
    setImported(true);
    setTimeout(() => setImported(false), 2000);
  }

  // 拖入文件等同于点选文件；文本拖拽仍交给 textarea 自己处理。
  function handleDrop(e: DragEvent<HTMLDivElement>) {
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    e.preventDefault();
    void pickFile(file);
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
          {imported && <span className="text-sm text-muted">{t("cv.import.done")}</span>}
          {/* Markdown 导入入口：选文件后先预览确认，再填入编辑器 */}
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            title={t("cv.import.hint")}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-hover disabled:opacity-60 max-sm:min-h-[44px]"
          >
            {importing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {t("cv.import.button")}
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".md,.markdown,.txt"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              // 清空 value，否则连续导入同一个文件不会触发 change
              e.target.value = "";
              if (file) void pickFile(file);
            }}
          />
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

      {importError && (
        <p className="mt-4 flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0" /> {t(IMPORT_ERROR_KEY[importError])}
        </p>
      )}

      {!loaded ? (
        <div className="mt-6 text-sm text-muted">{t("cv.editor.loading")}</div>
      ) : (
        <div
          className="mt-6 grid gap-4 lg:grid-cols-2"
          onDragOver={(e) => {
            // 只在拖入文件时接管，普通文本拖拽仍归 textarea
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={handleDrop}
        >
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

      {/* 导入覆盖确认框：编辑器已有内容时先问一句（dirty 时追加未保存警告） */}
      {pendingImport && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" role="dialog" aria-modal>
          <div className="absolute inset-0 bg-black/40" onClick={() => setPendingImport(null)} aria-hidden />
          <div className="relative w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-xl">
            <h3 className="font-display text-lg tracking-tight">{t("cv.import.confirmTitle")}</h3>
            <p className="mt-2 break-all rounded-lg bg-surface p-2 font-mono text-xs text-muted">{pendingImport.name}</p>
            <p className="mt-2 text-sm text-muted">{t("cv.import.confirmBody")}</p>
            {dirty && <p className="mt-2 rounded-lg bg-surface p-3 text-sm text-muted">{t("cv.history.confirmDirty")}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPendingImport(null)}>
                {t("cv.import.cancel")}
              </Button>
              <Button variant="primary" size="sm" onClick={() => applyImport(pendingImport.content)}>
                {t("cv.import.confirm")}
              </Button>
            </div>
          </div>
        </div>
      )}

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
