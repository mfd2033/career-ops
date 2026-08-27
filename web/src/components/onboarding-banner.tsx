"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, X, Settings } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

type Doctor = { available: boolean; onboardingNeeded: boolean; missing: string[]; warnings: string[] };

function hasCli(): boolean {
  try {
    return !!JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId;
  } catch {
    return false;
  }
}

const LABELS: Record<string, string> = {
  "cv.md": "shared.onboarding.cv",
  "config/profile.yml": "shared.onboarding.profile",
  "modes/_profile.md": "shared.onboarding.personalization",
  "portals.yml": "shared.onboarding.portals",
};

// Detect (via the core's doctor.mjs) whether setup is incomplete, and offer to
// finish it CONVERSATIONALLY — the assistant asks in plain language and writes
// the canonical files (no YAML to edit). This is the #1 adoption barrier.
export function OnboardingBanner() {
  const [d, setD] = useState<Doctor | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [cli, setCli] = useState(true); // assume until read (avoid CTA flash)
  const { t } = useI18n();

  useEffect(() => {
    setCli(hasCli());
    fetch("/api/doctor")
      .then((r) => r.json())
      .then(setD)
      .catch(() => {});
  }, []);

  if (dismissed || !d || !d.onboardingNeeded) return null;
  const items = d.missing.map((m) => (LABELS[m] ? t(LABELS[m]) : m));
  const kickoff = t("shared.onboarding.kickoff", { items: items.join(", ") });

  return (
    <div className="dot-bg relative mb-6 overflow-hidden rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/10 via-surface/40 to-transparent p-5">
      <button
        onClick={() => setDismissed(true)}
        className="absolute right-3 top-3 text-faint transition-colors hover:text-foreground"
        aria-label={t("shared.onboarding.dismiss")}
      >
        <X className="size-4" />
      </button>
      <h2 className="font-display text-xl text-landing">{t("shared.onboarding.title")}</h2>
      <p className="mt-1.5 max-w-xl text-sm text-muted">
        {t("shared.onboarding.bodyLead", { items: items.join(", ") })}
        <span className="text-foreground">{t("shared.onboarding.noYaml")}</span>
        {t("shared.onboarding.bodyTail")}
      </p>
      {cli ? (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("co-assistant", { detail: { message: kickoff } }))}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
        >
          <Sparkles className="size-4" /> {t("shared.onboarding.setupWithAssistant")}
        </button>
      ) : (
        // The assistant needs a CLI to run — without one the kickoff would silently
        // drop. Send them to connect one first.
        <Link
          href="/config"
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
        >
          <Settings className="size-4" /> {t("shared.onboarding.connectCli")}
        </Link>
      )}
    </div>
  );
}
