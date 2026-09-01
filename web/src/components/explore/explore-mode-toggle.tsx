"use client";

import { Compass, Globe, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { CostBadge } from "@/components/cost/cost-badge";
import type { ExploreMode } from "@/lib/explore";
import { useI18n } from "@/lib/i18n/context";

// Cost honesty rendered at the POINT OF CHOICE: free deterministic Scan (default)
// vs token-spending AI search. The AI segment stays selectable even with no CLI —
// selecting it reveals the blocked state (more discoverable than a dead tab).
// The browser segment is also free and needs the bsk CLI + a connected browser;
// without one it reveals its own blocked card on selection.
export function ExploreModeToggle({
  mode,
  onChange,
  cliConfigured,
}: {
  mode: ExploreMode;
  onChange: (m: ExploreMode) => void;
  cliConfigured: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex w-full rounded-xl border border-border bg-surface/40 p-1 sm:inline-flex sm:w-auto">
      <button
        type="button"
        onClick={() => onChange("scan")}
        aria-pressed={mode === "scan"}
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm transition-colors sm:flex-none sm:gap-2 sm:px-3 max-sm:min-h-[44px]",
          mode === "scan" ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
        )}
      >
        <Compass className="size-4" />
        <span className="font-medium">{t("explore.mode.scan")}</span>
        <span className="hidden sm:inline-flex">
          <CostBadge kind="free-network" size="xs" />
        </span>
      </button>
      <button
        type="button"
        onClick={() => onChange("browser")}
        aria-pressed={mode === "browser"}
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm transition-colors sm:flex-none sm:gap-2 sm:px-3 max-sm:min-h-[44px]",
          mode === "browser" ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
        )}
      >
        <Globe className="size-4" />
        <span className="font-medium">{t("explore.mode.browser")}</span>
        <span className="hidden sm:inline-flex">
          <CostBadge kind="free-network" size="xs" />
        </span>
      </button>
      <button
        type="button"
        onClick={() => onChange("ai")}
        aria-pressed={mode === "ai"}
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm transition-colors sm:flex-none sm:gap-2 sm:px-3 max-sm:min-h-[44px]",
          mode === "ai" ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
        )}
      >
        <Sparkles className="size-4" />
        <span className="font-medium">{t("explore.mode.aiSearch")}</span>
        <span className="hidden sm:inline-flex">
          <CostBadge kind="spend" size="xs" />
        </span>
        {!cliConfigured && <span className="text-[10px] text-faint">{t("explore.mode.needsCli")}</span>}
      </button>
    </div>
  );
}
