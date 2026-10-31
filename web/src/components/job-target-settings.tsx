"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Plus, Save, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";
import { ARCHETYPE_FIT_VALUES } from "@/lib/profile-patch.mjs";

// 求职意向 → config/profile.yml 的 target_roles，两个同级字段由同一张卡管理
// （ADR-0091 + ADR-0092）：目标职位是纯检索词列表（primary，前 6 条生效）；
// 原型是评估打分依据的方向画像，每行可编辑 name / level（自由文本）/ fit
// （三档分层：primary/secondary/adjacent），保存时按名 reconcile——合法 fit
// 与非空 level 覆盖磁盘值，缺失沿用；枚举外的手编 fit 以原样值的自定义选项
// 回传，服务端按未提供处理（不静默改写）。空原型名单保存 = 删键。探索页/
// 扫描的关键词播种口径是 primary + archetypes.name 合并（与核心
// providers/_profile-keywords.mjs 同口径）。加载失败时不回退默认值（否则会
// 显示过期数据且保存会覆盖真实 profile.yml），而是显示错误 + 重试。

type ArchetypeRow = { name: string; level: string; fit: string };

const fieldClass =
  "rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40";

export function JobTargetSettings() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [roleText, setRoleText] = useState("");
  const [archetypes, setArchetypes] = useState<ArchetypeRow[]>([]);
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
      .then((d: { roles?: unknown; archetypes?: unknown }) => {
        const roles = Array.isArray(d.roles)
          ? d.roles.filter((r): r is string => typeof r === "string")
          : [];
        setRoleText(roles.join("\n"));
        // GET 返回整条对象（extractArchetypes 保留 level/fit）；此前前端把
        // level/fit 扔掉只留名字（ADR-0092 改为完整预填）。
        const rows = Array.isArray(d.archetypes)
          ? d.archetypes.flatMap((a): ArchetypeRow[] => {
              if (!a || typeof a !== "object") return [];
              const raw = a as { name?: unknown; level?: unknown; fit?: unknown };
              if (typeof raw.name !== "string" || raw.name.trim() === "") return [];
              return [
                {
                  name: raw.name,
                  level: typeof raw.level === "string" ? raw.level : "",
                  fit: typeof raw.fit === "string" && raw.fit !== "" ? raw.fit : "primary",
                },
              ];
            })
          : [];
        setArchetypes(rows);
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
    // 原型与目标职位同一次 PATCH：空名单 = 删键（ADR-0091 三态语义），不拦
    // 「原型为空」——目标职位不能空，原型可以。空白名字的行直接丢弃；level/
    // fit 原样回传，服务端按 ADR-0092 语义决定覆盖还是沿用。
    const archetypeEntries = archetypes
      .map((r) => ({ name: r.name.trim(), level: r.level.trim(), fit: r.fit }))
      .filter((r) => r.name !== "");
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roles, archetypes: archetypeEntries }),
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

  const updateRow = (i: number, patch: Partial<ArchetypeRow>) => {
    setArchetypes((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const removeRow = (i: number) => {
    setArchetypes((rows) => rows.filter((_, j) => j !== i));
  };

  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface p-4">
      <h3 className="font-display text-[17px] font-medium leading-tight text-landing">{t("config.jobTargetTitle")}</h3>
      <p className="mt-1 text-xs leading-relaxed text-faint">{t("config.jobTargetDesc")}</p>
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
          <label className="mt-3 flex flex-col">
            <span className="block text-sm font-medium text-foreground">{t("config.jobTargetRoles")}</span>
            <span className="mt-0.5 block text-xs text-faint">{t("config.jobTargetHint")}</span>
            <textarea
              value={roleText}
              onChange={(e) => setRoleText(e.target.value)}
              rows={3}
              placeholder={t("config.jobTargetPlaceholder")}
              className={cn("mt-1.5 min-h-[74px] w-full resize-y", fieldClass)}
            />
          </label>
          <div className="mt-3 flex flex-col">
            <span className="block text-sm font-medium text-foreground">{t("config.jobTargetArchetypes")}</span>
            <span className="mt-0.5 block text-xs text-faint">{t("config.jobTargetArchetypeHint")}</span>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {archetypes.map((row, i) => (
                <div
                  key={i}
                  /* flex-wrap：窄容器下 level/select/删除钮换行，行不撑破卡
                      （config 设置页 390 溢出修复，UI 审计 FAIL #6）。 */
                  className="flex flex-wrap items-center gap-1.5"
                >
                  <input
                    value={row.name}
                    onChange={(e) => updateRow(i, { name: e.target.value })}
                    placeholder={t("config.jobTargetArchetypeNamePlaceholder")}
                    className={cn("min-w-0 flex-1", fieldClass)}
                  />
                  <input
                    value={row.level}
                    onChange={(e) => updateRow(i, { level: e.target.value })}
                    placeholder={t("config.jobTargetArchetypeLevelPlaceholder")}
                    className={cn("w-32 shrink-0", fieldClass)}
                  />
                  <select
                    value={row.fit}
                    onChange={(e) => updateRow(i, { fit: e.target.value })}
                    aria-label={t("config.jobTargetArchetypeFit")}
                    className={cn("w-28 shrink-0", fieldClass)}
                  >
                    <option value="primary">{t("config.jobTargetFitPrimary")}</option>
                    <option value="secondary">{t("config.jobTargetFitSecondary")}</option>
                    <option value="adjacent">{t("config.jobTargetFitAdjacent")}</option>
                    {/* 手编 profile.yml 的枚举外 fit 原样显示并回传——服务端按
                        未提供处理，不静默改写（ADR-0092 决议 3）。 */}
                    {!ARCHETYPE_FIT_VALUES.includes(row.fit) && <option value={row.fit}>{row.fit}</option>}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    aria-label={t("config.jobTargetArchetypeRemove")}
                    className="shrink-0 rounded-md border border-border bg-surface p-2 text-faint transition-colors hover:bg-surface-hover hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setArchetypes([...archetypes, { name: "", level: "", fit: "primary" }])}
                className="mt-0.5 inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <Plus className="size-3.5" /> {t("config.jobTargetArchetypeAdd")}
              </button>
            </div>
          </div>
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
