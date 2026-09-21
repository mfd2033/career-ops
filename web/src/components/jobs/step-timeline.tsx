"use client";

import { Wrench, CircleDot } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

/**
 * 步骤时间线的共享渲染（ADR-0047 决议 5）：工具行用扳手图标 + 「正在使用 {label}」
 * 文案，状态行用圆点图标 + 原文。工作器详情页的 live 视图与 ledger-only 视图（含
 * 事后从台账重建的步骤流）共用此组件，同一 `JobStep` 口径——避免第三份 inline 重复
 * （沿 ADR-0045 `BatchItemList` 惯例）。空/缺步骤渲染为 null（诚实空白，不显示空壳）。
 *
 * `ts` 可选：live 卡片每步带客户端接收时刻，台账重建的步骤带服务端墙钟时刻（旧行可能
 * 无）；本组件不显示时刻，仅按数组顺序渲染，故两者皆可。
 */
export function StepTimeline({ steps }: { steps?: Array<{ kind: "tool" | "status"; label: string; ts?: number }> }) {
  const { t } = useI18n();
  if (!steps || steps.length === 0) return null;
  return (
    <ol className="mt-6 space-y-2">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm">
          {s.kind === "tool" ? (
            <Wrench className="mt-0.5 size-3.5 shrink-0 text-brand" />
          ) : (
            <CircleDot className="mt-0.5 size-3.5 shrink-0 text-faint" />
          )}
          <span className={cn(s.kind === "tool" ? "font-medium" : "text-muted")}>
            {s.kind === "tool" ? t("jobs.usingTool", { label: s.label }) : s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
