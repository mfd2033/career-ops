"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Save } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// JD evaluation / exclusion rules → config/profile.yml. Server-persisted
// (unlike the localStorage engine prefs above): the evaluation pipeline reads
// profile.yml directly (modes/oferta.md + context-budget), so rules saved here
// apply to every evaluation — including "re-evaluate" on the pipeline detail
// page. deal_breakers is a free-text list (one rule per line);
// location_flexibility is free text. On a failed load we do NOT fall back to
// defaults: the user would see stale rules with no warning and a Save would
// overwrite their real profile.yml. Show an error + Retry instead.

type JdRules = { dealBreakers: string[]; locationFlexibility: string };

const EMPTY: JdRules = { dealBreakers: [], locationFlexibility: "" };

function parseResponse(r: Response): Promise<Partial<JdRules> & { error?: string }> {
  return r.json().catch(() => ({}));
}

export function JdRulesSettings() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [rules, setRules] = useState<JdRules>(EMPTY);
  const [dealText, setDealText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(false);
    fetch("/api/profile")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: Partial<JdRules>) => {
        const next: JdRules = {
          dealBreakers: Array.isArray(d.dealBreakers) ? d.dealBreakers.filter((b): b is string => typeof b === "string") : [],
          locationFlexibility: typeof d.locationFlexibility === "string" ? d.locationFlexibility : "",
        };
        setRules(next);
        setDealText(next.dealBreakers.join("\n"));
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    const dealBreakers = dealText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const payload: Partial<JdRules> = { dealBreakers };
    if (rules.locationFlexibility.trim() !== "") payload.locationFlexibility = rules.locationFlexibility.trim();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await parseResponse(res);
      if (!res.ok) {
        setError(typeof j.error === "string" ? j.error : t("config.jdRulesSaveError"));
      } else {
        setRules((r) => ({ ...r, dealBreakers, locationFlexibility: payload.locationFlexibility ?? r.locationFlexibility }));
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      setError(t("config.jdRulesSaveError"));
    }
    setSaving(false);
  };

  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface p-4">
      <h3 className="font-display text-[17px] font-medium leading-tight text-landing">{t("config.jdRulesTitle")}</h3>
      <p className="mt-1 text-xs leading-relaxed text-faint">{t("config.jdRulesDesc")}</p>
      {loadError ? (
        <div className="mt-3 text-sm text-muted">
          <p className="text-red-500">{t("config.jdRulesLoadError")}</p>
          <button
            type="button"
            onClick={load}
            className="mt-2 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface-hover"
          >
            {t("followups.retry")}
          </button>
        </div>
      ) : !loaded ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> {t("followups.loading")}
        </div>
      ) : (
        <>
          <label className="mt-3 block">
            <span className="block text-sm font-medium text-foreground">{t("config.dealBreakers")}</span>
            <span className="mt-0.5 block text-xs text-faint">{t("config.dealBreakersHint")}</span>
            <textarea
              value={dealText}
              onChange={(e) => setDealText(e.target.value)}
              rows={2}
              placeholder={t("config.dealBreakersPlaceholder")}
              className="mt-1.5 w-full resize-y rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
            />
          </label>
          <label className="mt-4 block flex-1">
            <span className="block text-sm font-medium text-foreground">{t("config.locationFlexibility")}</span>
            <span className="mt-0.5 block text-xs text-faint">{t("config.locationFlexibilityHint")}</span>
            <textarea
              value={rules.locationFlexibility}
              onChange={(e) => setRules((r) => ({ ...r, locationFlexibility: e.target.value }))}
              rows={2}
              placeholder={t("config.locationFlexibilityPlaceholder")}
              className="mt-1.5 w-full resize-y rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
            />
          </label>
          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className={cn(
                "inline-flex items-center gap-2 rounded-[10px] bg-brand px-4 py-2 text-[13px] font-semibold text-brand-foreground transition-colors hover:bg-brand-200",
                "disabled:pointer-events-none disabled:opacity-60",
              )}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
              {saved ? t("config.saved") : t("config.saveButton")}
            </button>
            <span className="font-mono text-[11px] text-faint">{t("config.persistProfile")}</span>
          </div>
        </>
      )}
    </div>
  );
}
