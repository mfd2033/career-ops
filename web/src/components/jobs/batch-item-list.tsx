"use client";

import Link from "next/link";
import { Check, AlertTriangle } from "lucide-react";
import type { JobItem } from "./job-store";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";
import { fmtDuration } from "@/lib/format";
import { fmtStartedAt } from "@/lib/started-at.mjs";
import { formatRunEngine } from "@/lib/cli-labels.mjs";
import { batchItemDetailHref } from "@/lib/batch-child-ledger.mjs";
import { BatchItemRetryButton } from "@/components/jobs/batch-item-retry-button";

// 演示/无效域名（RFC 2606 保留域）：历史批量运行里拿这类 URL 试跑过，条目仍在
// 台账里——降权显示而不隐藏记录（UI 审计 2026-10-31 FAIL #13）。
const PLACEHOLDER_URL_RE = /^(https?:\/\/)?(www\.)?example\.(com|net|org)(\/|$)/i;

function isPlaceholderUrl(label: string) {
  return PLACEHOLDER_URL_RE.test(label.trim());
}

/**
 * 批量逐项的卡片渲染（ADR-0046，升级 ADR-0045 的最小行）：状态图标 + 名称/公司 +
 * 分数/星级 + 完成时刻 + 引擎 + 时长 + 失败/跳过原因。成功且知道父批量 id 的子项
 * 渲染为可点卡片 → 跳它自己的独立详情页 /jobs/{childId}（childId 由服务端落盘的
 * 子台账行同算法算出）；失败/跳过项不可点，原因内联。历史列表展开区与批量详情页
 * 共用本组件，同一 JobItem 口径。引擎是整个批量派发时请求的值（子项继承）。
 */
export function BatchItemList({
  items,
  batchId,
  cliId,
  model,
}: {
  items: JobItem[];
  batchId?: string;
  cliId?: string;
  model?: string;
}) {
  const { t } = useI18n();
  const engine = formatRunEngine(cliId, model);
  return (
    <ul className="mt-2 grid max-h-[28rem] gap-2 overflow-y-auto sm:grid-cols-2">
      {items.map((it) => {
        const href = batchItemDetailHref(batchId, it);
        const secs = it.startedAt != null && it.finishedAt != null ? Math.round((it.finishedAt - it.startedAt) / 1000) : null;
        const clock = fmtStartedAt(it.finishedAt ?? it.ts);
        const inner = (
          <>
            <div className="flex items-start gap-2">
              {it.ok ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
              ) : it.skipped ? (
                <span className="mt-0.5 shrink-0 text-zinc-400">{"\u23F8"}</span>
              ) : (
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              )}
              {/* 演示/无效域名（RFC 2606 保留域，如历史批量试跑的 example.com）：记录不
                  隐藏，但降权展示不抢注意力（UI 审计 2026-10-31 FAIL #13）。 */}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  isPlaceholderUrl(it.label) ? "italic text-faint" : it.ok ? "font-medium" : "text-muted",
                )}
                title={isPlaceholderUrl(it.label) ? `${it.label} · ${t("jobs.placeholderDomain")}` : it.label}
              >
                {it.label}
              </span>
              {it.ok && it.score != null && <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{it.score}/5</span>}
              {it.ok && it.star != null && <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{"\u2605"}{it.star}/5</span>}
              {/* ADR-0093：终态失败的 evaluate 子项可单独重跑（独立工作器，父批量
                  失败记录保留）；成功/跳过/占位项由纯函数拦掉。 */}
              {!it.ok && !it.skipped && <BatchItemRetryButton item={it} cliId={cliId} model={model} className="mt-0.5" />}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-[11px] tabular-nums text-faint">
              {clock && <span title={t("jobs.endedAt", { time: clock })}>{clock}</span>}
              {secs != null && (
                <span title={t("jobs.evalDuration")}>
                  <Check className="mr-0.5 inline size-2.5" />
                  {fmtDuration(secs)}
                </span>
              )}
              {engine && (
                <span className="truncate" title={`${t("jobs.runEngine", { engine })} — ${t("jobs.runEngineHint")}`}>
                  {engine}
                </span>
              )}
            </div>
            {!it.ok && it.reason && <div className="mt-1 truncate pl-5 text-[11px] text-faint" title={it.reason}>— {it.reason}</div>}
            {/* ADR-0049：运行中项内联显示最后 5 步工具动作。 */}
            {it.steps && it.steps.length > 0 && (
              <div className="mt-1 pl-5 text-[10px] leading-tight text-faint/80">
                {it.steps.slice(-5).map((s, i) => (
                  <div key={i} className="truncate" title={s.label}>{s.kind === "tool" ? "\u25B8" : "\u00B7"} {s.label}</div>
                ))}
              </div>
            )}
          </>
        );
        return (
          <li key={it.key}>
            {href ? (
              <Link
                href={href}
                title={t("jobs.batchOpenDetail")}
                className="block rounded-xl border border-border bg-surface/60 p-2.5 transition-colors hover:border-brand/50 hover:bg-surface-hover"
              >
                {inner}
              </Link>
            ) : (
              <div className="rounded-xl border border-border bg-surface/40 p-2.5">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
