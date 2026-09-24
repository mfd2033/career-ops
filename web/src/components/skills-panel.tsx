"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// 技能面板（ADR-0056 决议 2/3/4）：配置页对本机 agent 技能的知情展示。
// 聚焦白名单各一张卡片，聚合各技能副本的安装路径与版本号，最高版本标当前；
// 未安装以徽标如实呈现——不隐藏、不拦截任何功能（体检 worker 读不到技能时按
// workflow 第 8 条自行降级）。安装/升级是 skills-manager 的职责，这里零动作。
// 数据来自 GET /api/skills（决议 8：每请求实时扫，无缓存）。

type SkillCopy = { name: string; version: string | null; path: string; agentDir: string };
type SkillGroup = { name: string; topVersion: string | null; copies: SkillCopy[] };

// 聚焦白名单（决议 2）：扫描器通用，展示面只渲染这几个；加技能改这里即可。
const FEATURED_SKILLS = ["offer体检", "browser-skill"];

export function SkillsPanel() {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/skills")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: { skills?: SkillGroup[] }) => {
        if (alive) setSkills(Array.isArray(d.skills) ? d.skills : []);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const byName = new Map((skills ?? []).map((s) => [s.name, s]));

  return (
    <div>
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("config.skillsTitle")}
      </label>
      <div className="rounded-xl border border-border bg-surface/50 p-4">
        <p className="text-xs leading-relaxed text-faint">{t("config.skillsDesc")}</p>
        {failed ? (
          <p className="mt-3 text-sm text-red-500">{t("config.skillsLoadError")}</p>
        ) : skills === null ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> {t("followups.loading")}
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {FEATURED_SKILLS.map((name) => {
              const group = byName.get(name);
              const open = expanded === name;
              return (
                <div key={name} className="rounded-lg border border-border bg-surface/60">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : name)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                  >
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
                        group
                          ? "bg-brand-soft text-foreground"
                          : "border border-border text-muted",
                      )}
                    >
                      {group ? t("config.aiToolGroupInstalled") : t("config.aiToolGroupMissing")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">{name}</span>
                      {group && (
                        <span className="block text-xs text-faint">
                          {t("config.skillsVersionLabel", {
                            version: group.topVersion ?? t("config.skillsVersionUnlabeled"),
                          })}
                        </span>
                      )}
                    </span>
                    <ChevronDown
                      className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")}
                    />
                  </button>
                  {open && group && (
                    <div className="border-t border-border px-3 py-2">
                      {name === "offer体检" && (
                        <p className="mb-2 text-xs text-faint">{t("config.skillsOfferHint")}</p>
                      )}
                      <p className="mb-1.5 text-xs text-muted">
                        {t("config.skillsCopiesCount", { count: group.copies.length })}
                      </p>
                      <ul className="space-y-1.5">
                        {group.copies.map((c, i) => (
                          <li key={c.path} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                            <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-muted">
                              {c.agentDir}
                            </span>
                            <span className="min-w-0 break-all font-mono text-muted">{c.path}</span>
                            {i === 0 && c.version && (
                              <span className="shrink-0 rounded-full bg-brand-soft px-1.5 py-0.5 text-faint">
                                {t("config.skillsCurrent")}
                              </span>
                            )}
                            <span
                              className={cn(
                                "ml-auto shrink-0 font-mono",
                                c.version ? "text-foreground" : "text-faint",
                              )}
                            >
                              {c.version ?? t("config.skillsVersionUnlabeled")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
