"use client";

import { useEffect, useId, useState } from "react";
import { FolderOpen, Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// 技能面板（ADR-0056 决议 2/3/4）：配置页对本机 agent 技能的知情展示。
// 聚焦白名单各一张扁平单行卡（对齐已验收原型 .skill）：徽标 + 技能名 +
// 副行「找到 N 个副本 · 用途说明」+ 右侧「vX.Y.Z · 当前版本」。副本的具体路径
// 已折叠进「N 个副本」计数——原型是唯一事实来源，如实呈现聚合结果即可。
// 「装在哪」这一问（ADR-0056 修订 1 的 realPath）不占单行卡版面，改为悬停在
// 副本计数上的 tooltip 呈现当前（最高版本）副本解析链接后的真实位置。
// 未安装以徽标如实呈现——不隐藏、不拦截任何功能（体检 worker 读不到技能时按
// workflow 第 8 条自行降级）。安装/升级是 skills-manager 的职责，这里零动作。
// 数据来自 GET /api/skills（决议 8：每请求实时扫，无缓存）。
//
// 额外安装目录（面板底部）：技能库不一定在五个默认位置（真机库在 D: 盘），
// 用户可手动输入路径或点目录按钮从系统对话框选择。目录存服务端（/api/skills
// POST）——展示与体检派发必须共用同一份扫描输入，存 localStorage 会造出
// 「面板看得见、派发读不到」的静默不一致。

type SkillCopy = { name: string; version: string | null; path: string; realPath?: string; agentDir: string };
type SkillGroup = { name: string; topVersion: string | null; copies: SkillCopy[] };
type SkillsPayload = { skills?: SkillGroup[]; skillDirs?: string[] };

// 聚焦白名单（决议 2）：扫描器通用，展示面只渲染这几个；加技能改这里即可。
const FEATURED_SKILLS = ["offer体检", "browser-skill"];

// 每个聚焦技能的用途说明文案 key（原型副行有、须成对补齐 en+zh）。
const SKILL_HINT_KEY: Record<string, string> = {
  "offer体检": "config.skillsOfferHint",
  "browser-skill": "config.skillsBskHint",
};

/** 输入形状的快速判断（服务端还会再归一化一次）：绝对路径、盘符或 `~` 开头。
 *  只用来在提交前说清「这个值根本没机会成立」，不作为真值来源。 */
function looksLikeDir(value: string): boolean {
  const text = value.trim();
  return (
    text === "~" ||
    text.startsWith("~/") ||
    text.startsWith("~\\") ||
    text.startsWith("/") ||
    text.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(text)
  );
}

export function SkillsPanel() {
  const { t } = useI18n();
  const dirInputId = useId();
  const [skills, setSkills] = useState<SkillGroup[] | null>(null);
  const [skillDirs, setSkillDirs] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/skills")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: SkillsPayload) => {
        if (!alive) return;
        setSkills(Array.isArray(d.skills) ? d.skills : []);
        setSkillDirs(Array.isArray(d.skillDirs) ? d.skillDirs : []);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 保存整张目录表并采纳服务端回扫结果；失败时返回 null，界面保留旧列表。 */
  async function saveDirs(next: string[]): Promise<string[] | null> {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillDirs: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as SkillsPayload;
      const savedDirs = Array.isArray(data.skillDirs) ? data.skillDirs : [];
      setSkills(Array.isArray(data.skills) ? data.skills : []);
      setSkillDirs(savedDirs);
      return savedDirs;
    } catch {
      setNotice(t("config.skillsDirSaveError"));
      return null;
    } finally {
      setSaving(false);
    }
  }

  /** 加一个目录。从对话框选出来的（传参）不碰输入框，手动输入的加完即清空。 */
  async function addDir(picked?: string) {
    const value = (picked ?? draft).trim();
    if (!value) return;
    if (picked === undefined && !looksLikeDir(value)) {
      setNotice(t("config.skillsDirInvalid"));
      return;
    }
    const before = skillDirs.length;
    const saved = await saveDirs([...skillDirs, value]);
    if (!saved) return;
    // 服务端会丢掉默认清单里已有的目录与重复项：数量没变就是它已经被扫过了。
    if (saved.length <= before) {
      setNotice(t("config.skillsDirAlreadyScanned"));
      return;
    }
    if (picked === undefined) setDraft("");
  }

  /** 打开系统目录对话框；选中的路径直接加入扫描范围。 */
  async function pickDir() {
    setPicking(true);
    setNotice(null);
    try {
      const res = await fetch("/api/clis/pick-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: draft.trim() }),
      });
      const data = (await res.json()) as { status?: string; dir?: string; reason?: string };
      if (data.status === "picked" && typeof data.dir === "string" && data.dir) {
        await addDir(data.dir);
      } else if (data.status !== "cancelled") {
        setNotice(pickNoticeText(data));
      }
    } catch {
      setNotice(t("config.cliDirPickFailed"));
    } finally {
      setPicking(false);
    }
  }

  /** 对话框没给出目录时说清为什么，落在用户能做的动作上（与配置页引擎目录同一纪律）。 */
  function pickNoticeText(result: { status?: string; reason?: string }): string {
    if (result.status === "busy") return t("config.cliDirPickBusy");
    if (result.status === "unsupported") return t("config.cliDirPickUnsupported");
    return result.reason === "timeout" ? t("config.cliDirPickTimeout") : t("config.cliDirPickFailed");
  }

  async function removeDir(dir: string) {
    await saveDirs(skillDirs.filter((d) => d !== dir));
  }

  const byName = new Map((skills ?? []).map((s) => [s.name, s]));
  const busy = saving || picking;

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
            // 当前（最高版本）副本的真实安装位置：realPath 优先，解析失败回落 path。
            const topCopy = group?.copies[0];
            const location = topCopy ? topCopy.realPath || topCopy.path : null;
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
                    <div
                      className="mt-0.5 truncate text-[11.5px] text-faint"
                      title={location ? t("config.skillsInstallLocation", { path: location }) : undefined}
                    >
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

          {/* 额外安装目录：改变的是扫描范围，不是技能本身。与上方卡片同一竖向节奏，
              不另起分割线/容器；「添加」是这里唯一的主操作，选择与移除都降级为图标。 */}
          <div>
            <label
              htmlFor={dirInputId}
              className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted"
            >
              {t("config.skillsDirsLabel")}
            </label>
            <p className="mb-2 mt-1 text-[11.5px] leading-relaxed text-faint">{t("config.skillsDirsHint")}</p>
            <div className="flex items-center gap-1.5">
              <input
                id={dirInputId}
                type="text"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setNotice(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addDir();
                  }
                }}
                placeholder={t("config.skillsDirsPlaceholder")}
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-foreground outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40 max-sm:min-h-[44px]"
              />
              <button
                type="button"
                onClick={() => void pickDir()}
                disabled={busy}
                aria-label={`${t("config.skillsDirsLabel")} · ${t("config.cliDirBrowse")}`}
                title={t("config.cliDirBrowse")}
                className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px] max-sm:min-w-[44px]"
              >
                {picking ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => void addDir()}
                disabled={busy || !draft.trim()}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground transition-colors hover:bg-brand-200 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]"
              >
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                {t("config.skillsDirsAdd")}
              </button>
            </div>
            {/* 常驻 live region：读屏用户在按钮变「保存中」后也能收到结论。 */}
            <p
              role="status"
              aria-live="polite"
              className={cn("text-[11.5px] leading-relaxed", notice ? "mt-1.5 text-amber-700 dark:text-amber-400" : "sr-only")}
            >
              {notice ?? ""}
            </p>
            {skillDirs.length === 0 ? (
              <p className="mt-2 text-[11.5px] text-faint">{t("config.skillsDirsEmpty")}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {skillDirs.map((dir) => (
                  <li key={dir} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" title={dir}>
                      {dir}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeDir(dir)}
                      disabled={busy}
                      aria-label={`${t("config.skillsDirsRemove")}：${dir}`}
                      title={t("config.skillsDirsRemove")}
                      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-faint transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px] max-sm:min-w-[44px]"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
