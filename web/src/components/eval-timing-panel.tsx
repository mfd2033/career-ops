"use client";

import { Clock } from "lucide-react";
import { fmtDuration } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import type { EvalTimingEntry } from "@/lib/eval-timing";

// The 评估用时 breakdown (latest eval session, all steps) on the detail
// surfaces: /pipeline/{n} below the report and /jobs/{id} below the timeline.
// The counted report-delivery steps vs the not-counted delayed ones
// (pdf/answers/tracker, ADR-0016) are visually separated so the total's scope
// is legible without reading the ADR.
const STEP_KEYS: Record<string, string> = {
  extract: "pipeline.timing.step.extract",
  liveness: "pipeline.timing.step.liveness",
  eval: "pipeline.timing.step.eval",
  report: "pipeline.timing.step.report",
  pdf: "pipeline.timing.step.pdf",
  answers: "pipeline.timing.step.answers",
  tracker: "pipeline.timing.step.tracker",
};

export function EvalTimingPanel({ entry }: { entry: EvalTimingEntry | null }) {
  const { t } = useI18n();
  if (!entry || entry.steps.length === 0) return null;
  const stepLabel = (s: string) => {
    const key = STEP_KEYS[s];
    return key ? t(key) : s;
  };
  const counted = entry.steps.filter((s) => ["extract", "liveness", "eval", "report"].includes(s.step));
  const deferred = entry.steps.filter((s) => !["extract", "liveness", "eval", "report"].includes(s.step));
  return (
    <div className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
        <Clock className="mr-1.5 inline size-3.5" />
        {t("pipeline.timing.title")}
      </h2>
      <div className="mt-3 rounded-2xl border border-border bg-surface/40 px-5 py-4 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-display text-xl tabular-nums">{fmtDuration(entry.duration)}</span>
          <span className="text-xs text-faint">{t("pipeline.timing.scopeHint")}</span>
          {entry.finishedAt && (
            <span className="ml-auto text-xs tabular-nums text-faint">
              {t("pipeline.timing.finishedAt", { date: entry.finishedAt })}
            </span>
          )}
        </div>
        <ul className="mt-3 divide-y divide-border/60">
          {counted.map((s, i) => (
            <li key={`c-${i}`} className="flex items-center justify-between py-1.5">
              <span className="text-muted">{stepLabel(s.step)}</span>
              <span className="tabular-nums text-faint">{fmtDuration(s.seconds)}</span>
            </li>
          ))}
          {deferred.length > 0 && (
            <li className="pt-2 text-[11px] text-faint">{t("pipeline.timing.deferredHint")}</li>
          )}
          {deferred.map((s, i) => (
            <li key={`d-${i}`} className="flex items-center justify-between py-1.5 text-faint">
              <span className="text-faint/80">{stepLabel(s.step)}</span>
              <span className="tabular-nums">{fmtDuration(s.seconds)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
