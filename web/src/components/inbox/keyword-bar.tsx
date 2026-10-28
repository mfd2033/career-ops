"use client";

import { useState } from "react";
import { Tag } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";
import { KEYWORD_TOP_N } from "@/lib/inbox-keywords.mjs";

// 收件箱关键词条（ADR-0068）：零 token 的 chip 过滤器。chip 数据由服务端
// 装配（报告词节 ∪ 词典命中），这里只展示与选中。按命中行数降序取前
// KEYWORD_TOP_N 枚带计数；行数为 0 的词条不会进 counts。2026-10-28 从工具条
// chips 行移到常驻批量条右侧（由调用方包 ml-auto），本组件只负责单行 chip 列，
// 横向滚动/换行都交给外层条体。
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
      // 常驻批量条右侧内联单行；不再自带纵距/横滚（外层条体处理）。
      className="flex shrink-0 items-center gap-1.5"
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
