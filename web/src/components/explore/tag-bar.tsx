"use client";

import { useState } from "react";
import { Tag, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";
import { RESULT_TAG_TOP_N } from "@/lib/result-tags.mjs";

// 探索页结果标签条（交互对齐收件箱关键词条，ADR-0068 决议 3/4）：
// chip 上带命中条数、点选即过滤（chip 之间 OR）、超出上限就地展开、无标签整条隐藏。
// 与收件箱的差别只有一处摆放：探索页没有定高列表，这里独占一行挂在结果 tab 下方，
// 不做「塞进常驻批量条右侧」的密度改造。
export function TagBar({
  counts,
  selected,
  onToggle,
  onClear,
}: {
  counts: [string, number][];
  selected: Set<string>;
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!counts.length) return null;
  const shown = expanded ? counts : counts.slice(0, RESULT_TAG_TOP_N);
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t("explore.results.tagsAria")}>
      <Tag className="size-3 shrink-0 text-faint" aria-hidden="true" />
      {shown.map(([tag, n]) => (
        <button
          key={tag}
          type="button"
          onClick={() => onToggle(tag)}
          aria-pressed={selected.has(tag)}
          title={t("explore.results.tagChipTitle", { tag, n })}
          className={cn(
            "shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors max-sm:min-h-[44px]",
            selected.has(tag) ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:text-foreground",
          )}
        >
          {tag} <span className="tabular-nums text-faint">{n}</span>
        </button>
      ))}
      {counts.length > RESULT_TAG_TOP_N && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-full px-2 py-0.5 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]"
        >
          {expanded ? t("explore.results.tagCollapse") : t("explore.results.tagExpand", { n: counts.length - RESULT_TAG_TOP_N })}
        </button>
      )}
      {selected.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]"
        >
          <X className="size-3" /> {t("explore.results.tagsClear", { n: selected.size })}
        </button>
      )}
    </div>
  );
}
