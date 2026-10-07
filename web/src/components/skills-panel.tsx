"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// 技能面板（ADR-0056 决议 2/3/4）：配置页对本机 agent 技能的知情展示。
// 聚焦白名单各一张扁平单行卡（对齐已验收原型 .skill）：徽标 + 技能名 +
// 副行「找到 N 个副本 · 用途说明」+ 右侧「vX.Y.Z · 当前版本」。副本的具体路径
// 已折叠进「N 个副本」计数——原型是唯一事实来源，如实呈现聚合结果即可。
// 未安装以徽标如实呈现——不隐藏、不拦截任何功能（体检 worker 读不到技能时按
// workflow 第 8 条自行降级）。安装/升级是 skills-manager 的职责，这里零动作。
// 数据来自 GET /api/skills（决议 8：每请求实时扫，无缓存）。

type SkillCopy = { name: string; version: string | null; path: string; realPath?: string; agentDir: string };
type SkillGroup = { name: string; topVersion: string | null; copies: SkillCopy[] };

// 聚焦白名单（决议 2）：扫描器通用，展示面只渲染这几个；加技能改这里即可。
const FEATURED_SKILLS = ["offer体检", "browser-skill"];

// 每个聚焦技能的用途说明文案 key（原型副行有、须成对补齐 en+zh）。
const SKILL_HINT_KEY: Record<string, string> = {
  "offer体检": "config.skillsOfferHint",
  "browser-skill": "config.skillsBskHint",
};

export function SkillsPanel() {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillGroup[] | null>(null);
  const [failed, setFailed] = useState(false);

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
      {failed ? (
        <p className="text-sm text-red-500">{t("config.skillsLoadError")}</p>
      ) : skills === null ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> {t("followups.loading")}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {FEATURED_SKILLS.map((name) => {
            const group = byName.get(name);
            const hintKey = SKILL_HINT_KEY[name];
            return (
              <div
                key={name}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3"
              >
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-semibold",
                    group ? "bg-brand-soft text-foreground" : "border border-border text-muted",
                  )}
                >
                  {group ? t("config.aiToolGroupInstalled") : t("config.aiToolGroupMissing")}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-semibold text-foreground">{name}</div>
                  {group && (
                    <div className="mt-0.5 truncate text-[11.5px] text-faint">
                      {t("config.skillsCopiesCount", { count: group.copies.length })}
                      {hintKey ? ` · ${t(hintKey)}` : ""}
                    </div>
                  )}
                </div>
                {group && (
                  <div className="ml-auto shrink-0 font-mono text-[11.5px] text-muted">
                    {group.topVersion ? `v${group.topVersion}` : t("config.skillsVersionUnlabeled")}
                    {` · ${t("config.skillsCurrent")}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
