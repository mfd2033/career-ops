"use client";

import { useEffect, useRef, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

// Reveals the tailored CV PDF in the OS file manager (File Explorer on Windows)
// with the file selected — the backend spawns `explorer /select,"path"`. Mirrors
// GeneratePdfButton's placement: only rendered once a tailored CV exists
// (pdfReady), so it never needs a disabled state beyond the in-flight guard.
export function OpenCvFolderButton({ company }: { company: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const open = async () => {
    setStatus("loading");
    setMsg("");
    try {
      const res = await fetch("/api/cv-pdf/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setStatus("ok");
        setMsg(t("pipeline.openCvFolderOk"));
        timer.current = setTimeout(() => {
          setStatus("idle");
          setMsg("");
        }, 3000);
      } else {
        setStatus("error");
        setMsg(t("pipeline.openCvFolderError", { error: (data && typeof data.error === "string" ? data.error : res.statusText) ?? String(res.status) }));
      }
    } catch (err) {
      setStatus("error");
      setMsg(t("pipeline.openCvFolderError", { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={open}
        disabled={status === "loading"}
        title={t("pipeline.openCvFolderTitle")}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-60 max-sm:min-h-[44px]"
      >
        {status === "loading" ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
        {t("pipeline.openCvFolder")}
      </button>
      {status === "ok" && (
        <span className="text-xs text-emerald-600 dark:text-emerald-400" role="status">
          {msg}
        </span>
      )}
      {status === "error" && (
        <span className="text-xs text-red-600 dark:text-red-400" role="alert">
          {msg}
        </span>
      )}
    </span>
  );
}