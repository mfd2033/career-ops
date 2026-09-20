import type { JobItem } from "./job-store";

/**
 * 批量逐项清单的最小集渲染（ADR-0045 决议 3）：名称 + 结果符号 + 分数/星级 +
 * 失败原因，子项行不可交互。从详情页既有面板（ADR-0042 决议 5）抽出同款标记，
 * 历史列表展开与 ledger-only 详情视图共用——同一 JobItem 形状，同一口径。
 */
export function BatchItemList({ items }: { items: JobItem[] }) {
  return (
    <ul className="mt-2 max-h-72 list-none space-y-1.5 overflow-y-auto rounded-2xl border border-border bg-surface/40 p-4">
      {items.map((it) => (
        <li key={it.key} className="flex items-start gap-2 text-sm">
          <span className="shrink-0">{it.ok ? "\u2705" : it.skipped ? "\u23F8" : "\u26A0\uFE0F"}</span>
          <span className={it.ok ? "" : "text-muted"}>
            {it.label}
            {it.ok && it.score != null && <span className="text-faint"> · {it.score}/5</span>}
            {it.ok && it.star != null && <span className="text-faint"> · {"\u2605"}{it.star}/5</span>}
            {!it.ok && it.reason && <span className="text-faint"> — {it.reason}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
