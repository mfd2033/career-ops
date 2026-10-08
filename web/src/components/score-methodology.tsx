"use client";

import Link from "next/link";
import { ChevronDown, BookOpen } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

// 透明度 = 我们的差异点（“为什么这份职位对你是 4.0”）。这里是摘要：维度与区块
// 一速览，全文在站内 /methodology（基于 career-ops.org/methodology 改写，
// 口径以 modes/_shared.md + modes/oferta.md 为准）。
// Native <details> → no client JS.

export function ScoreMethodology() {
  const { t } = useI18n();

  const DIMENSIONS: [string, string][] = [
    [t("pipeline.dim.match"), t("pipeline.dim.matchDesc")],
    [t("pipeline.dim.northstar"), t("pipeline.dim.northstarDesc")],
    [t("pipeline.dim.comp"), t("pipeline.dim.compDesc")],
    [t("pipeline.dim.culture"), t("pipeline.dim.cultureDesc")],
    [t("pipeline.dim.redflags"), t("pipeline.dim.redflagsDesc")],
    [t("pipeline.dim.overall"), t("pipeline.dim.overallDesc")],
  ];

  const BLOCKS: [string, string][] = [
    ["A", t("pipeline.block.a")],
    ["B", t("pipeline.block.b")],
    ["C", t("pipeline.block.c")],
    ["D", t("pipeline.block.d")],
    ["E", t("pipeline.block.e")],
    ["F", t("pipeline.block.f")],
    ["G", t("pipeline.block.g")],
    ["H", t("pipeline.block.h")],
  ];

  return (
    <details className="group mt-10 overflow-hidden rounded-2xl border border-border bg-surface/30">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-medium transition-colors hover:bg-surface-hover">
        {t("pipeline.methodologySummary")}
        <ChevronDown className="ml-auto size-4 text-faint transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-5 border-t border-border px-5 py-4 text-sm">
        <p className="text-muted">
          {t("pipeline.methodologyIntro")}
        </p>
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-faint">{t("pipeline.dimensionsTitle")}</div>
          <ul className="space-y-1.5">
            {DIMENSIONS.map(([k, v]) => (
              <li key={k}>
                <span className="font-medium text-foreground">{k}</span> <span className="text-muted">— {v}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-faint">{t("pipeline.blocksTitle")}</div>
          <ul className="space-y-2">
            {BLOCKS.map(([k, v]) => (
              <li key={k} className="flex items-start gap-2.5">
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded bg-brand-soft text-xs font-semibold text-brand">
                  {k}
                </span>
                <span className="text-muted">{v}</span>
              </li>
            ))}
          </ul>
        </div>
        <Link
          href="/methodology"
          aria-label={t("pipeline.methodologyAria")}
          className="inline-flex min-h-[24px] items-center gap-1 text-xs text-brand transition-colors hover:underline max-sm:min-h-[44px]"
        >
          {t("pipeline.methodologyFull")} <BookOpen className="size-3" aria-hidden="true" />
        </Link>
      </div>
    </details>
  );
}
