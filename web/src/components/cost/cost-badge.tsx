"use client";

import { Leaf, Coins, Sparkles } from "lucide-react";
import { COST_META, type CostClass } from "@/lib/explore-cost";
import { useI18n } from "@/lib/i18n/context";

// One primitive, four variants — the app's cost color-semantics (career-ops-ux
// lock, for DESIGN_SYSTEM.md): GREEN = free/positive (celebrate); NEUTRAL/muted
// (+ coin icon) = spend ("Uses tokens") — it INFORMS, it must not alarm nor
// celebrate, and crucially it must NOT be brand-orange: orange is reserved for
// the primary action (e.g. "Run your first FREE scan"), so an orange spend badge
// would collide ("go/free" vs "costs") and shout louder than the action itself.
// Muted spend AA-verified in both themes. Styles live in globals.css (.co-cost).

// The visible label/tip live in COST_META (explore-cost.ts); we route them
// through the i18n dictionary so they can be localized without editing that
// shared source. English entries mirror the original strings exactly.
const LABEL_KEY: Record<CostClass, string> = {
  "free-network": "shared.cost.free",
  free: "shared.cost.free",
  spend: "shared.cost.spend",
  "free-gemini": "shared.cost.freeGemini",
};
const TIP_KEY: Record<CostClass, string> = {
  "free-network": "shared.cost.freeNetworkTip",
  free: "shared.cost.freeTip",
  spend: "shared.cost.spendTip",
  "free-gemini": "shared.cost.freeGeminiTip",
};

export function CostBadge({ kind, size = "sm", className = "" }: { kind: CostClass; size?: "xs" | "sm"; className?: string }) {
  const { t } = useI18n();
  const tone = kind === "spend" ? "spend" : "free";
  const Icon = kind === "spend" ? Coins : kind === "free-gemini" ? Sparkles : Leaf;
  return (
    <span className={`co-cost ${className}`} data-tone={tone} data-size={size} title={t(TIP_KEY[kind])}>
      <Icon aria-hidden />
      {t(LABEL_KEY[kind])}
    </span>
  );
}
