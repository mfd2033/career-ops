"use client";

import { CircleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

// 会消耗 tokens 的操作提示：圆圈内感叹号图标，鼠标悬浮由原生 title 给出完整说明。
// 免费操作不再挂任何徽章——不提示本身就代表免费，去掉徽章减少视觉噪音。
export function CostHint({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span
      role="img"
      aria-label={t("shared.cost.spend")}
      title={t("shared.cost.spendTip")}
      className={`inline-flex shrink-0 items-center ${className}`}
    >
      <CircleAlert className="size-3.5" aria-hidden />
    </span>
  );
}