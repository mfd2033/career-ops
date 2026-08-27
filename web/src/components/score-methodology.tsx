"use client";

import { ChevronDown, ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

// Transparency = our differentiator ("why it's a 4.0 for YOU"). The wording is
// the CANONICAL public text from career-ops.org/methodology + /docs — rendered
// verbatim, NOT a web reinterpretation of the rubric (whose weights live in the
// core, modes/_shared.md). Native <details> → no client JS.

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
        <a
          href="https://career-ops.org/methodology"
          target="_blank"
          rel="noreferrer"
          aria-label={t("pipeline.methodologyAria")}
          className="inline-flex min-h-[24px] items-center gap-1 text-xs text-brand transition-colors hover:underline max-sm:min-h-[44px]"
        >
          {t("pipeline.methodologyFull")} <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </div>
    </details>
  );
}
