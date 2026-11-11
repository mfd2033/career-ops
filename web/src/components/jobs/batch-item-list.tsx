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
import { PostingLinkButton } from "@/components/jobs/posting-link-button";
import { jobPostingUrl } from "@/lib/job-posting-url.mjs";

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
  parentTerminal = false,
  retryKept,
}: {
  items: JobItem[];
  batchId?: string;
  cliId?: string;
  model?: string;
  /** 父批量是否已达终态（done/error）——ADR-0093 修订 1：终态下没收到结论的
   *  失败项（流断掉的 item-running 占位）也可重试，且如实标明「结论丢失」。 */
  parentTerminal?: boolean;
  /** ADR-0095：本轮重试跳过的项键（结论沿用上一轮）——这些行不是本次刚跑的，
   *  要标清楚，否则重试中的卡片看起来像已经跑完了全部。 */
  retryKept?: string[];
}) {
  const { t } = useI18n();
  const engine = formatRunEngine(cliId, model);
  const keptSet = new Set(retryKept ?? []);
  return (
    <ul className="mt-2 grid max-h-[28rem] gap-2 overflow-y-auto sm:grid-cols-2">
      {items.map((it) => {
        const href = batchItemDetailHref(batchId, it);
        const fromPrevAttempt = keptSet.has(it.key);
        const secs = it.startedAt != null && it.finishedAt != null ? Math.round((it.finishedAt - it.startedAt) / 1000) : null;
        // ADR-0093 修订 1：父批量已终态却没收到该条结论（item-running 占位没有
        // reason）——要如实说明，不能让失败项看起来无因无故。
        const lostConclusion = parentTerminal && !it.ok && !it.skipped && !it.reason;
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
              {/* ADR-0095：本轮重试跳过的项（上一轮已成功）——降权标注「未重跑」，
                  与本次真正重跑的项区分开。 */}
              {fromPrevAttempt && (
                <span
                  className="shrink-0 rounded bg-surface-hover px-1 py-0.5 text-[10px] text-faint"
                  title={t("jobs.batchItemRetryKeptHint")}
                >
                  {t("jobs.batchItemRetryKept")}
                </span>
              )}
              {/* 职位原帖：逐项的 key 才是该条 URL（label 是可读的「公司 · 岗位」，
                  checkup 批量的 key 是 tracker#N），新标签页打开。z-10 浮在整卡的
                  拉伸链接之上，点它不跳站内详情。 */}
              <PostingLinkButton url={jobPostingUrl(it.key)} className="relative z-10 mt-0.5" />
              {/* ADR-0093：终态失败的 evaluate 子项可单独重跑（独立工作器，父批量
                  失败记录保留）；成功/跳过/占位项由纯函数拦掉。引擎不随派发透传——
                  修订 2：重试取派发那一刻的最新模型配置。 */}
              {!it.ok && !it.skipped && (
                <BatchItemRetryButton item={it} parentTerminal={parentTerminal} className="relative z-10 mt-0.5" />
              )}
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
            {!it.ok && (it.reason || lostConclusion) && (
              <div className="mt-1 truncate pl-5 text-[11px] text-faint" title={it.reason ?? t("jobs.batchItemNoConclusion")}>
                — {it.reason ?? t("jobs.batchItemNoConclusion")}
              </div>
            )}
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
            {/* 站内详情由「整卡是 Link」改成拉伸链接覆盖层：卡内现在有外链图标和重试
                按钮，<a> 不能嵌套 <a>。覆盖层排在内容之后（画在上层）负责整卡点击，
                两个交互控件各自 relative z-10 浮在它之上。 */}
            <div
              className={cn(
                "relative rounded-xl border p-2.5 transition-colors",
                href ? "border-border bg-surface/60 hover:border-brand/50 hover:bg-surface-hover" : "border-border bg-surface/40",
              )}
            >
              {inner}
              {href && (
                <Link
                  href={href}
                  title={t("jobs.batchOpenDetail")}
                  aria-label={t("jobs.batchOpenDetail")}
                  className="absolute inset-0 rounded-xl"
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
