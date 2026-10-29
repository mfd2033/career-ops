"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Save } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// 薪资目标三项 → config/profile.yml 的 compensation（target_range / minimum）。
// 评估管线直接读 profile.yml，并以 minimum 作 hard_stop 底线（modes/zh/oferta.md），
// 所以这三项一旦保存就作用于每一次评估，包括详情页的「重新评估」与 CLI。
// 保存时同时镜像 modes/_profile.md 的「## Your Comp Targets」段（服务端做），
// 避免两个文件里的底线数字互相矛盾。
//
// 书写格式（currency 前缀 / K 这类单位后缀）不在本卡里编辑：GET 从磁盘现值解析后
// 回传，保存时原样带回，所以 "25K-30K" 不会被写回成 "25-30"。磁盘上还没有值时
// 兜底用 "K"（与 onboarding 生成的 profile.yml 同一口径）。
//
// 加载失败时不回退默认值：那会让用户看到一份过期数字，且一保存就覆盖真实配置。

type SalaryFields = {
  compMin: number | null;
  compMax: number | null;
  compFloor: number | null;
  compPrefix: string;
  compUnit: string;
};

const EMPTY: SalaryFields = { compMin: null, compMax: null, compFloor: null, compPrefix: "", compUnit: "" };
const DEFAULT_UNIT = "K";

const inputClass =
  "w-full rounded-md border border-border bg-surface/60 px-3 py-2 pr-10 text-right text-sm tabular-nums outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40";

function toDraft(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "" : String(v);
}

/**
 * 实际使用的单位后缀：磁盘上已有的写法优先；一次都没配过时兜底 "K"（与 onboarding
 * 生成的 profile.yml 同一口径）；已配过但没写单位（"25-30"）则保持无单位——
 * 保存时不替用户发明书写格式。
 */
function effectiveUnit(fields: SalaryFields): string {
  if (fields.compUnit) return fields.compUnit;
  const untouched = fields.compMin === null && fields.compMax === null && fields.compFloor === null;
  return untouched ? DEFAULT_UNIT : "";
}

export function SalaryTargetSettings() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [format, setFormat] = useState<SalaryFields>(EMPTY);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [floor, setFloor] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(false);
    setLoaded(false);
    fetch("/api/profile")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: Partial<SalaryFields>) => {
        const next: SalaryFields = {
          compMin: typeof d.compMin === "number" ? d.compMin : null,
          compMax: typeof d.compMax === "number" ? d.compMax : null,
          compFloor: typeof d.compFloor === "number" ? d.compFloor : null,
          compPrefix: typeof d.compPrefix === "string" ? d.compPrefix : "",
          compUnit: typeof d.compUnit === "string" ? d.compUnit : "",
        };
        setFormat(next);
        setMin(toDraft(next.compMin));
        setMax(toDraft(next.compMax));
        setFloor(toDraft(next.compFloor));
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    const nMin = Number(min);
    const nMax = Number(max);
    const nFloor = Number(floor);
    const allNumber = [nMin, nMax, nFloor].every((n) => Number.isFinite(n) && n > 0);
    if (min.trim() === "" || max.trim() === "" || floor.trim() === "" || !allNumber) {
      setError(t("config.salaryRequired"));
      return;
    }
    // 底线高于目标下限 = 自相矛盾的区间，服务端无从纠正，挡在提交前。
    if (nFloor > nMin || nMin > nMax) {
      setError(t("config.salaryOrderError"));
      return;
    }
    const unit = effectiveUnit(format);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          compMin: nMin,
          compMax: nMax,
          compFloor: nFloor,
          compPrefix: format.compPrefix,
          compUnit: unit,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof j.error === "string" ? j.error : t("config.salarySaveError"));
      } else {
        setFormat((f) => ({ ...f, compUnit: unit }));
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      setError(t("config.salarySaveError"));
    }
    setSaving(false);
  };

  const unitLabel = effectiveUnit(format);

  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface p-4">
      <h3 className="font-display text-[17px] font-medium leading-tight text-landing">{t("config.salaryTitle")}</h3>
      <p className="mt-1 text-xs leading-relaxed text-faint">{t("config.salaryDesc")}</p>
      {loadError ? (
        <div className="mt-3 text-sm text-muted">
          <p className="text-red-500">{t("config.salaryLoadError")}</p>
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
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-sm font-medium text-foreground">{t("config.salaryMin")}</span>
              <span className="mt-0.5 block text-xs text-faint">{t("config.salaryMinHint")}</span>
              <div className="relative mt-1.5">
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={min}
                  onChange={(e) => setMin(e.target.value)}
                  aria-label={t("config.salaryMin")}
                  className={cn(inputClass, "no-number-spin")}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">
                  {unitLabel}
                </span>
              </div>
            </label>
            <label className="block">
              <span className="block text-sm font-medium text-foreground">{t("config.salaryMax")}</span>
              <span className="mt-0.5 block text-xs text-faint">{t("config.salaryMaxHint")}</span>
              <div className="relative mt-1.5">
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                  aria-label={t("config.salaryMax")}
                  className={cn(inputClass, "no-number-spin")}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">
                  {unitLabel}
                </span>
              </div>
            </label>
          </div>
          <label className="mt-3 block">
            <span className="block text-sm font-medium text-foreground">{t("config.salaryFloor")}</span>
            <span className="mt-0.5 block text-xs text-faint">{t("config.salaryFloorHint")}</span>
            <div className="relative mt-1.5">
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
                aria-label={t("config.salaryFloor")}
                className={cn(inputClass, "no-number-spin")}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-faint">
                {unitLabel}
              </span>
            </div>
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
