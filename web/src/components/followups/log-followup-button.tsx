"use client";

import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { LogDialog } from "@/components/followups/log-dialog";
import type { CadenceEntry } from "@/lib/followups";
import { useI18n } from "@/lib/i18n/context";

// 报告页的「记录跟进」入口（ADR-0075）：entry 由路由从 core 同源输出装配
// （存在 = 本行可跟进；判定与联系人建议都来自这一份），弹窗原样复用
// /followups 的 LogDialog。成功后：关闭 + 页内轻提示（复制收件箱 toast 的
// 样式与 5 秒自动消失；重复成功以 seq 递增重置计时）；失败由弹窗自身保持
// 打开并显示错误（既有逻辑）。
export function LogFollowupButton({ entry }: { entry: CadenceEntry }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("followups.logTitle")}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
      >
        <Send className="size-3.5" /> {t("followups.logDialogTitle")}
      </button>
      {open && (
        <LogDialog
          entry={entry}
          onClose={() => setOpen(false)}
          onLogged={() => setToast((prev) => ({ text: t("followups.loggedToast"), seq: (prev?.seq ?? 0) + 1 }))}
        />
      )}
      {toast && (
        <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <div
            role="status"
            className="inline-flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 text-sm shadow-lg"
          >
            <span className="text-muted">{toast.text}</span>
          </div>
        </div>
      )}
    </>
  );
}
