"use client";

import { ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

// 「打开职位原帖」图标按钮（/jobs 行 + /jobs/[id] 详情页 + 批量逐项卡共用）。
//
// 只做一件事：把一条已经过 jobPostingUrl 校验的单条 URL 用新标签页打开。
// url 为 null（批量清单、报告号、公司名）时渲染 null——无数据不占位，也不做
// 死链，与 CliSessionButton / RetryJobButton 的自守卫口径一致。
//
// 行内使用时外层可能是站内 Link，外链本身是独立的 <a>（兄弟节点，不嵌套），
// 因此不会劫持行点击。
export function PostingLinkButton({ url, className }: { url?: string | null; className?: string }) {
  const { t } = useI18n();
  if (!url) return null;
  const label = t("jobs.openPosting");

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      className={cn("flex items-center px-1.5 text-faint transition-colors hover:text-foreground", className)}
    >
      <ExternalLink className="size-3.5 shrink-0" />
    </a>
  );
}
