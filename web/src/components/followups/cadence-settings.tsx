"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { PROFILE_CADENCE_KEYS, type ProfileCadenceKey } from "@/lib/followups";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// Follow-up cadence knobs → config/profile.yml (followup_cadence). Server-
// persisted (unlike the localStorage engine prefs above) because the core
// followup-cadence.mjs reads the same keys — the CLI and the web must agree.

const FIELDS: { key: ProfileCadenceKey; label: string; hint: string }[] = [
  { key: "applied_first_days", label: "followups.field.firstFollowup", hint: "followups.field.firstFollowupHint" },
  { key: "applied_subsequent_days", label: "followups.field.between", hint: "followups.field.betweenHint" },
  { key: "applied_max_followups", label: "followups.field.max", hint: "followups.field.maxHint" },
  { key: "responded_initial_days", label: "followups.field.replyWindow", hint: "followups.field.replyWindowHint" },
  { key: "responded_subsequent_days", label: "followups.field.respondedCadence", hint: "followups.field.respondedCadenceHint" },
  { key: "interview_thankyou_days", label: "followups.field.thankyou", hint: "followups.field.thankyouHint" },
];

export function CadenceSettings() {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<ProfileCadenceKey, string> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On a failed load, do NOT fall back to defaults: the user would see 7/7/2/…
  // with no warning and a Save would overwrite their real profile.yml
  // overrides. Show an error + Retry instead.
  const load = useCallback(() => {
    setLoadError(false);
    fetch("/api/followups/cadence")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => {
        // `effective` is already defaults+overrides, computed server-side from
        // the CORE's cadenceDefaults (#2369) — no local defaults table to merge
        // in. A key the core didn't supply renders empty rather than as an
        // invented number.
        const eff = (d?.effective ?? {}) as Partial<Record<ProfileCadenceKey, number>>;
        setValues(Object.fromEntries(
          PROFILE_CADENCE_KEYS.map((k) => [k, eff[k] === undefined ? "" : String(eff[k])]),
        ) as Record<ProfileCadenceKey, string>);
      })
      .catch(() => setLoadError(true));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!values) return;
    const payload: Partial<Record<ProfileCadenceKey, number>> = {};
    for (const k of PROFILE_CADENCE_KEYS) {
      // Number(), not parseInt(): "3.5" and "7abc" must be rejected, not truncated.
      const raw = values[k].trim();
      const n = raw === "" ? Number.NaN : Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        setError(t("followups.fieldNumberError", { label: t(FIELDS.find((f) => f.key === k)?.label ?? "") }));
        return;
      }
      payload[k] = n;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/followups/cadence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof j.error === "string" ? j.error : t("followups.saveError"));
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      setError(t("followups.saveError"));
    }
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      {loadError ? (
        <div className="text-sm text-muted">
          <p className="text-red-500">
            {t("followups.cadenceLoadErrorPre")}
            <span className="font-mono">config/profile.yml</span>
            {t("followups.cadenceLoadErrorPost")}
          </p>
          <button
            type="button"
            onClick={load}
            className="mt-2 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface-hover"
          >
            {t("followups.retry")}
          </button>
        </div>
      ) : values === null ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> {t("followups.loading")}
        </div>
      ) : (
        <>
          {/* 两组并排设置行（已申请阶段 / 回复与面试），窄屏堆叠为单列。 */}
          <div className="grid grid-cols-2 gap-x-10 max-[640px]:grid-cols-1 max-[640px]:gap-y-6">
            {([
              { title: t("followups.cadenceGroupApplied"), fields: FIELDS.slice(0, 3) },
              { title: t("followups.cadenceGroupReply"), fields: FIELDS.slice(3) },
            ] as const).map((group) => (
              <div key={group.title}>
                <div className="mb-0.5 border-b border-border pb-2 text-[11px] font-bold tracking-wide text-faint">
                  {group.title}
                </div>
                <div className="flex flex-col">
                  {group.fields.map((f, i) => (
                    <div
                      key={f.key}
                      className={cn(
                        "flex items-center justify-between gap-4 py-2.5",
                        i > 0 && "border-t border-border",
                      )}
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-foreground">{t(f.label)}</div>
                        <div className="mt-px text-xs text-faint">{t(f.hint)}</div>
                      </div>
                      <span className="inline-flex flex-none items-baseline gap-1">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={values[f.key]}
                          onChange={(e) => setValues((v) => (v ? { ...v, [f.key]: e.target.value } : v))}
                          aria-label={t(f.label)}
                          className="no-number-spin w-24 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-right text-sm tabular-nums text-foreground outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
                        />
                        <i className="not-italic text-xs text-muted">
                          {f.key === "applied_max_followups" ? t("followups.unitTimes") : t("followups.unitDays")}
                        </i>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className={cn(
                "inline-flex items-center gap-2 rounded-[10px] bg-brand px-4 py-2 text-[13px] font-semibold text-brand-foreground transition-colors hover:bg-brand-200",
                "disabled:pointer-events-none disabled:opacity-60",
              )}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : null}
              {saved ? t("followups.saved") : t("config.saveButton")}
            </button>
            <span className="font-mono text-[11px] text-faint">{t("config.persistProfile")}</span>
          </div>
        </>
      )}
    </div>
  );
}
