"use client";

import { Coins, Search, X } from "lucide-react";
import type { AtsSource } from "@/lib/explore";
import { ATS_LABEL } from "@/lib/explore";
import { FRESHNESS_WINDOWS, SENIORITY_LABEL, type Seniority } from "@/lib/inbox";
import { CostBadge } from "@/components/cost/cost-badge";
import { InputClearButton } from "@/components/input-clear-button";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

// Free, client-side facets over the raw firehose — 0 tokens, instant. Mirrors the
// Explore chip language so the two surfaces read as one system. On mobile the chip
// row scrolls INSIDE its own container (never the page).
export function FacetChips({
  within,
  setWithin,
  sources,
  toggleSource,
  seniorities,
  toggleSeniority,
  unscoredOnly,
  onToggleUnscoredOnly,
  locQ,
  setLocQ,
  kw,
  setKw,
  salaryMin,
  setSalaryMin,
  sortBySalary,
  onToggleSortBySalary,
  availSources,
  availSeniorities,
  resultCount,
  totalCount,
  anyActive,
  onClear,
}: {
  within: number | null;
  setWithin: (d: number | null) => void;
  sources: Set<AtsSource>;
  toggleSource: (s: AtsSource) => void;
  seniorities: Set<Seniority>;
  toggleSeniority: (s: Seniority) => void;
  unscoredOnly: boolean;
  onToggleUnscoredOnly: () => void;
  locQ: string;
  setLocQ: (v: string) => void;
  kw: string;
  setKw: (v: string) => void;
  salaryMin: number | null;
  setSalaryMin: (v: number | null) => void;
  sortBySalary: boolean;
  onToggleSortBySalary: () => void;
  availSources: AtsSource[];
  availSeniorities: Seniority[];
  resultCount: number;
  totalCount: number;
  anyActive: boolean;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2.5">
      {/* keyword search + live count */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder={t("inbox.filterPlaceholder")}
            // pr-8 常驻留白（ADR-0059 决定 8）：文字不滚到内嵌 × 下方
            className="w-full rounded-lg border border-border bg-surface/60 py-2 pl-9 pr-8 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40 max-sm:min-h-[44px]"
          />
          <InputClearButton show={kw.length > 0} onClear={() => setKw("")} label={t("inbox.clearKeyword")} />
        </div>
        <span className="shrink-0 text-xs text-muted">
          <span className="tabular-nums text-foreground">{resultCount}</span>
          <span className="text-faint">/{totalCount}</span>
        </span>
      </div>

      {/* chip row — desktop wraps, mobile scrolls inside the container */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
        {/* freshness (single-select segmented; click active to clear) */}
        <div className="inline-flex shrink-0 rounded-lg border border-border bg-surface/40 p-0.5">
          {FRESHNESS_WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setWithin(within === w.days ? null : w.days)}
              className={cn(
                "rounded-md px-2.5 text-xs font-medium transition-colors max-sm:min-h-[44px]",
                within === w.days ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>

        {/* unscored-only toggle — the cheap "what's left to evaluate" filter */}
        <Pill on={unscoredOnly} onClick={onToggleUnscoredOnly}>
          {t("inbox.unscoredOnly")}
        </Pill>

        {/* 按薪资排序切换（ADR-0023 决定 4）：开 = 中位值降序、未知沉底；
            关 = 默认新鲜度。与薪资下限同区摆放。 */}
        <Pill on={sortBySalary} onClick={onToggleSortBySalary}>
          <Coins className="mr-0.5 inline size-3" />
          {t("inbox.sortBySalary")}
        </Pill>

        {availSources.map((s) => (
          <Pill key={s} on={sources.has(s)} onClick={() => toggleSource(s)}>
            {ATS_LABEL[s]}
          </Pill>
        ))}

        {availSeniorities.map((s) => (
          <Pill key={s} on={seniorities.has(s)} onClick={() => toggleSeniority(s)}>
            {SENIORITY_LABEL[s]}
          </Pill>
        ))}

        {/* location contains（ADR-0059：包 relative 容纳内嵌 ×；w-28→w-32 加宽留 × 位） */}
        <div className="relative shrink-0">
          <input
            value={locQ}
            onChange={(e) => setLocQ(e.target.value)}
            placeholder={t("inbox.locationPlaceholder")}
            className="w-32 rounded-full border border-border bg-surface/40 py-1 pl-3 pr-7 text-xs outline-none transition-colors placeholder:text-faint focus:border-brand/40 max-sm:min-h-[44px]"
          />
          <InputClearButton show={locQ.length > 0} onClear={() => setLocQ("")} label={t("inbox.clearLocation")} className="right-1.5" />
        </div>

        {/* 薪资下限（月薪 K）——与探索页同一语义同一文案（ADR-0023）：区间重叠
            判定，薪资未知行放行并保持打标。空 = 不过滤。 */}
        <div className="relative shrink-0">
          <Coins className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-faint" />
          <input
            type="number"
            min={1}
            step="0.5"
            value={salaryMin ?? ""}
            onChange={(e) => {
              const n = Number(e.target.value);
              setSalaryMin(Number.isFinite(n) && n > 0 ? n : null);
            }}
            placeholder={t("explore.filter.zhSalaryMinPlaceholder")}
            title={t("explore.filter.zhSalaryMin")}
            aria-label={t("explore.filter.zhSalaryMin")}
            // pr-10 留 × + 原生 spinner 位；× 定位在 spinner 左侧（ADR-0059 决定 8）
            className="w-28 shrink-0 rounded-full border border-border bg-surface/40 pl-7 pr-10 py-1 text-xs outline-none transition-colors placeholder:text-faint focus:border-brand/40 max-sm:min-h-[44px]"
          />
          <InputClearButton show={salaryMin != null} onClear={() => setSalaryMin(null)} label={t("explore.filter.clearSalaryMin")} className="right-5" />
        </div>

        {anyActive && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]"
          >
            <X className="size-3" /> {t("inbox.clear")}
          </button>
        )}
      </div>

      {/* Token-honesty is bidirectional: the "free" reassurance is as always-visible
          as the tray's "spend" cue (mobile + desktop) — never desktop-only. */}
      <div className="flex items-center gap-1.5">
        <CostBadge kind="free" size="xs" />
        <span className="text-[11px] text-faint">{t("inbox.filterFree")}</span>
      </div>
    </div>
  );
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-2.5 text-xs font-medium transition-colors max-sm:min-h-[44px]",
        on ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
