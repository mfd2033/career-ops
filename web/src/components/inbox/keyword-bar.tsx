"use client";

import { useState } from "react";
import { Tag } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";
import { KEYWORD_TOP_N } from "@/lib/inbox-keywords.mjs";

// 收件箱关键词条（ADR-0068）：工具条下方独立一行的 chip 过滤器。零 token——
// chip 数据由服务端装配（报告词节 ∪ 词典命中），这里只展示与选中。按命中行数
// 降序取前 KEYWORD_TOP_N 枚带计数；行数为 0 的词条不会进 counts。窄屏行内
// 横向滚动（与 facet 工具条同款姿态），桌面 flex-wrap。
export function KeywordBar({
  counts,
  selected,
  onToggle,
}: {
  counts: [string, number][];
  selected: Set<string>;
  onToggle: (word: string) => void;
}) {
  const { t } = useI18n();
  // 「展开全部/收起」住组件内（ADR-0068 决议 4：就地展开不进 URL），
  // 只增减 chip 数量、不动列表区高度分配，不引起列表跳动。
  const [expanded, setExpanded] = useState(false);
  if (!counts.length) return null;
  const shown = expanded ? counts : counts.slice(0, KEYWORD_TOP_N);
  return (
    <div
      className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible sm:pb-0"
      aria-label={t("inbox.kwBarAria")}
    >
      <Tag className="size-3 shrink-0 text-faint" aria-hidden="true" />
      {shown.map(([word, n]) => (
        <button
          key={word}
          type="button"
          onClick={() => onToggle(word)}
          aria-pressed={selected.has(word)}
          title={t("inbox.kwChipTitle", { word, n })}
          className={cn(
            "shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors max-sm:min-h-[44px]",
            selected.has(word)
              ? "border-brand/40 bg-brand-soft text-brand"
              : "border-border text-muted hover:text-foreground",
          )}
        >
          {word} <span className="tabular-nums text-faint">{n}</span>
        </button>
      ))}
      {counts.length > KEYWORD_TOP_N && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded-full px-2 py-0.5 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]"
        >
          {expanded ? t("inbox.kwCollapse") : t("inbox.kwExpand", { n: counts.length - KEYWORD_TOP_N })}
        </button>
      )}
    </div>
  );
}
