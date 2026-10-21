"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Save } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// 评估模式（CO-51 / CO-65）→ config/profile.yml 的 `language.modes_dir`。
//
// 服务端持真值（同 JD 规则卡）：web 评估、批量 worker 与 CLI 都从 profile.yml 读这一项，
// 所以保存后立即对所有路径生效。可选项来自 GET /api/profile 的 marketModes ——
// 服务端扫 modes/* 下带 _shared.md 的目录，前端不维护第二份清单。
//
// 加载失败时**不**回落到默认值：那会显示一份空配置，用户一点保存就把真实的
// language.modes_dir 覆盖掉。改为显示错误 + 重试（同 jd-rules-settings 的理由）。

const ROOT_VALUE = "";

export function MarketModeSettings() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [options, setOptions] = useState<string[]>([]);
  const [value, setValue] = useState<string>(ROOT_VALUE);
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
      .then((d: { marketMode?: string | null; marketModes?: unknown }) => {
        const nextOptions = Array.isArray(d.marketModes)
          ? d.marketModes.filter((m): m is string => typeof m === "string")
          : [];
        const nextCurrent = typeof d.marketMode === "string" && d.marketMode.trim() ? d.marketMode.trim() : null;
        setOptions(nextOptions);
        setCurrent(nextCurrent);
        // `modes/zh` → `zh`；未配置或目录不存在时回落到「通用」，让下拉如实反映生效值。
        const slug = nextCurrent?.replace(/^modes\//, "") ?? "";
        setValue(nextOptions.includes(slug) ? slug : ROOT_VALUE);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "root" = 清空 language.modes_dir（服务端删键，不写 null）
        body: JSON.stringify({ marketMode: value || "root" }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(typeof j.error === "string" ? j.error : t("config.marketModeSaveError"));
      } else {
        setCurrent(value ? `modes/${value}` : null);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      setError(t("config.marketModeSaveError"));
    }
    setSaving(false);
  };

  /** 目录 slug → 显示名；未登记的目录退回大写的 slug，绝不显示原始 i18n 键。 */
  const labelFor = (slug: string) => {
    const key = `config.marketMode.${slug}`;
    const text = t(key);
    return text === key ? slug.toUpperCase() : text;
  };

  const orphanedSlug = current?.replace(/^modes\//, "") ?? "";
  const orphaned = current !== null && !options.includes(orphanedSlug);

  return (
    // h-full：跨整行（md 下 col-span-2）时与左侧两张卡等高，卡片底部对齐。
    <div className="flex h-full flex-col rounded-xl border border-border bg-surface p-4">
      <h3 className="font-display text-[17px] font-medium leading-tight text-landing">{t("config.marketModeTitle")}</h3>
      <p className="mt-1 text-xs leading-relaxed text-faint">{t("config.marketModeDesc")}</p>
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
          {/* 跨整行时不要把 <select> 拉成 760px 宽的横条输入框（与 config-form 的
              容器查询断点对齐）。 */}
          <label className="mt-3 block @2xl:max-w-[420px] @5xl:max-w-none">
            <span className="block text-sm font-medium text-foreground">{t("config.marketModeLabel")}</span>
            <select
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <option value={ROOT_VALUE}>{t("config.marketModeRoot")}</option>
              {options.map((slug) => (
                <option key={slug} value={slug}>
                  {labelFor(slug)}
                </option>
              ))}
              {/* profile.yml 手改成一个不存在的目录时把原值也列出来，避免下拉静默改写成「通用」 */}
              {orphaned && <option value={orphanedSlug}>{`${current}（不存在）`}</option>}
            </select>
            <span className="mt-1.5 block text-xs leading-relaxed text-faint">{t("config.marketModeHint")}</span>
          </label>
          <p className="mt-2 text-[11px] text-faint">
            {t("config.marketModeCurrent", { mode: value ? labelFor(value) : t("config.marketModeRoot") })}
          </p>
          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
          <div className="mt-auto flex flex-wrap items-center gap-2.5 pt-4">
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
