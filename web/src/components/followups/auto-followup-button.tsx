"use client";

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { AutoFollowupDialog } from "@/components/followups/auto-followup-dialog";
import type { CadenceEntry } from "@/lib/followups";
import { useI18n } from "@/lib/i18n/context";

// 报告页与今日待跟进卡片共用的「自动跟进」入口（⚡）：紧挨「记录跟进」左侧，
// 与跟进页行内那枚是同一枚弹窗（确认话术 → 扩展代发 → 回填记录），这里只管
// 入口与成功轻提示，发送/回填逻辑一行不搬。成功后弹窗自己关闭并回调 onLogged，
// 轻提示沿用「记录跟进」的文案、位置和 5 秒节奏——两种记法读起来一致。
//
// 两处页面共用一套排序，只是形态不同（原型 2026-11-12 确认）：
//   icon    今日卡片操作组：与相邻四个图标按钮同尺寸，颜色用 brand-text 标主操作；
//   outline 报告页操作行：描边圆形，与相邻胶囊同为 26px 高、同一条底边。
export function AutoFollowupButton({
  entry,
  onLogged,
  variant = "icon",
}: {
  entry: CadenceEntry;
  /** 记录成功后的额外回调（今日卡片用它刷新待跟进列表）。 */
  onLogged?: () => void;
  variant?: "icon" | "outline";
}) {
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
        title={t("followups.autoAction")}
        aria-label={t("followups.autoAction")}
        className={cn(
          "inline-flex shrink-0 items-center justify-center transition-colors hover:bg-brand-soft hover:text-brand max-sm:min-h-[44px]",
          variant === "icon"
            ? "size-8 rounded-lg text-brand-text max-sm:min-w-[44px]"
            : "rounded-full border border-border px-2 py-1 text-muted hover:border-brand/40",
        )}
      >
        <Zap className={variant === "icon" ? "size-4" : "size-3.5"} />
      </button>
      {open && (
        <AutoFollowupDialog
          entry={entry}
          onClose={() => setOpen(false)}
          onLogged={() => {
            onLogged?.();
            setToast((prev) => ({ text: t("followups.loggedToast"), seq: (prev?.seq ?? 0) + 1 }));
          }}
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
