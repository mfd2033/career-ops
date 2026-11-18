"use client";

import { ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

// 体检卡的报告入口：号 + 「体检」+ 外链符号合成一枚 chip，区别于评估卡的裸
// `#N`（后者去 /report/{n}，见 ReportNumLink）。
//
// 宿主多半是 <Link>（托盘卡、/jobs 行），所以与 ReportNumLink 同理用
// role="link" 的 span 而不是 <a>：嵌套锚点非法，preventDefault/stopPropagation
// 挡住外层跳转。新标签打开，与管道页「体检报告 ↗」同语义。
// 托盘宽 240，chip 与标题同处首行：内距与图标都取最小档，把宽度让给标题。
const BASE =
  "inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded bg-surface-hover px-1 py-0.5 font-medium tabular-nums leading-[14px] text-muted transition-colors hover:bg-brand-soft hover:text-brand-text";

export function CheckupReportChip({
  n,
  href,
  className,
}: {
  n: string;
  href: string;
  className?: string;
}) {
  const { t } = useI18n();
  const label = t("jobs.viewCheckupReport");
  const go = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(href, "_blank", "noopener,noreferrer");
  };
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") go(e);
      }}
      title={label}
      aria-label={label}
      className={cn(BASE, className)}
    >
      #{n} {t("jobs.checkupChip")}
      <ExternalLink className="size-2 shrink-0" />
    </span>
  );
}