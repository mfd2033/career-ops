"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// 求职意向（目标职位） → config/profile.yml 的 target_roles.primary，
// 与 JD 评估规则一样由服务器持久化（profile-patch.mjs 把 roles 映射到
// target_roles.primary）。评估流水线会直接读取 profile.yml，因此在这里
// 保存的求职意向对整个评估生效。每个职位占一行；加载失败时不回退默认值
// （否则会显示过期数据且保存会覆盖真实 profile.yml），而是显示错误 + 重试。

export function JobTargetSettings() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [roleText, setRoleText] = useState("");
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
      .then((d: { roles?: unknown }) => {
        const roles = Array.isArray(d.roles)
          ? d.roles.filter((r): r is string => typeof r === "string")
          : [];
        setRoleText(roles.join("\n"));
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    const roles = roleText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (roles.length === 0) {
      setError(t("config.jobTargetEmpty"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(typeof j.error === "string" ? j.error : t("config.jobTargetSaveError"));
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      setError(t("config.jobTargetSaveError"));
    }
    setSaving(false);
  };

  return (
    <div>
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("config.jobTargetTitle")}
      </label>
      <div className="rounded-xl border border-border bg-surface/50 p-4">
        <p className="text-xs leading-relaxed text-faint">{t("config.jobTargetDesc")}</p>
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
              <span className="block text-sm font-medium text-foreground">{t("config.jobTargetRoles")}</span>
              <span className="mt-0.5 block text-xs text-faint">{t("config.jobTargetHint")}</span>
              <textarea
                value={roleText}
                onChange={(e) => setRoleText(e.target.value)}
                rows={3}
                placeholder={t("config.jobTargetPlaceholder")}
                className="mt-1.5 w-full rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
              />
            </label>
            {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className={cn(
                "mt-4 inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface-hover",
                "disabled:pointer-events-none disabled:opacity-60",
              )}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5 text-emerald-400" /> : null}
              {saved ? t("config.jobTargetSaved") : t("config.saveJobTarget")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}