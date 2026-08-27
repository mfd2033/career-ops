"use client";

import { Languages, Pin } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import type { Lang } from "@/lib/i18n/types";
import { cn } from "@/lib/cn";

// Compact language switcher for the app chrome. A segmented EN/中文 control
// changes the live display language; the pin button marks the current language
// as the *default* (the one shown on first load / fresh browser before any
// explicit selection).
const OPTIONS: { value: Lang; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "zh", label: "中文" },
];

export function LanguageToggle({ className }: { className?: string }) {
  const { lang, setLang, defaultLang, setDefaultLang, t } = useI18n();
  const isDefault = defaultLang === lang;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">
        <Languages className="size-3" /> {t("shared.language")}
      </div>
      <div className="flex items-center gap-1 px-1">
        <div className="flex overflow-hidden rounded-md border border-border bg-surface">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setLang(o.value)}
              aria-pressed={lang === o.value}
              className={cn(
                "min-w-[3rem] px-2 py-1 text-xs font-medium transition-colors max-sm:min-h-[32px]",
                lang === o.value
                  ? "bg-brand-soft text-brand-text"
                  : "text-muted hover:bg-surface-hover hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setDefaultLang(lang)}
          aria-pressed={isDefault}
          aria-label={t("shared.setDefault")}
          title={isDefault ? t("shared.defaultLangIs", { lang: lang === "en" ? "English" : "简体中文" }) : t("shared.setDefault")}
          className={cn(
            "inline-flex min-h-[28px] min-w-[28px] items-center justify-center rounded-md p-1 text-faint transition-colors hover:bg-surface-hover hover:text-foreground",
            isDefault && "text-brand",
          )}
        >
          <Pin className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
