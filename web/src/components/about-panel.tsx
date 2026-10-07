"use client";

import { useEffect, useState } from "react";
import { Star, ExternalLink } from "lucide-react";
import { cn } from "@/lib/cn";
import { CoMark } from "@/components/co-mark";
import { BugReportControl } from "@/components/bug-report-control";
import { useI18n } from "@/lib/i18n/context";

type VersionMeta = {
  version?: string;
  coreVersion?: string;
  channel?: string;
  sha?: string;
  builtAt?: string;
  packaged?: boolean;
};

// 配置页「关于」区：把原先左下角悬浮的版本胶囊 + 报告问题入口收进来，常驻可见
// （不再只在 pre-release 渠道显示）。数据全部来自本机 /api/version，不联网。
export function AboutPanel() {
  const { t } = useI18n();
  const [meta, setMeta] = useState<VersionMeta | null>(null);

  useEffect(() => {
    fetch("/api/version")
      .then((r) => r.json())
      .then((d) => setMeta(d))
      .catch(() => {});
  }, []);

  const channel = meta?.channel || "";
  // pre-release（alpha/beta/rc）才给渠道上色，stable 走中性档。
  const isPre = !!channel && channel !== "stable";
  const builtTitle = meta?.builtAt ? `${t("config.aboutBuiltAt")} ${meta.builtAt}` : undefined;

  return (
    <div className="overflow-hidden rounded-[14px] border border-border bg-surface">
      {/* 品牌头：渐变带 + serif 字标 + 渠道徽标（复刻引擎卡的头部语言） */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-gradient-to-b from-brand-soft/80 to-transparent px-5 py-4">
        <CoMark size={38} />
        <div className="min-w-0">
          <div className="font-display text-[22px] leading-none tracking-tight text-landing">career-ops</div>
          <p className="mt-1.5 text-xs text-muted">
            {meta?.version ? `web ${meta.version}` : t("config.aboutLoading")}
            {meta?.coreVersion ? ` · core ${meta.coreVersion}` : ""}
          </p>
        </div>
        {isPre && (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand-soft px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-brand-text">
            <span className="size-1.5 animate-pulse rounded-full bg-brand" /> {channel}
          </span>
        )}
      </div>

      {/* 主体：左侧版本芯片网格 + 右侧简介与操作 */}
      <div className="grid gap-5 p-5 [grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr))]">
        <div className="grid grid-cols-2 gap-2.5 self-start">
          <Chip label={t("config.aboutWebVersion")} value={meta?.version || "—"} mono />
          <Chip label={t("config.aboutCoreVersion")} value={meta?.coreVersion || "—"} mono />
          <Chip label={t("config.aboutChannel")} value={channel || "—"} accent={isPre} />
          <Chip label={t("config.aboutBuild")} value={meta?.sha || "—"} mono title={builtTitle} />
        </div>

        <div className="flex flex-col">
          <p className="text-[13px] leading-relaxed text-muted">{t("config.aboutBlurb")}</p>
          {/* 操作行：主操作（报告问题）填充胶囊，次级链接描边胶囊，视觉分层 */}
          <div className="mt-auto flex flex-wrap items-center gap-2.5 pt-4">
            <BugReportControl compact />
            <a
              href="https://github.com/santifer/career-ops"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-foreground max-sm:min-h-[44px]"
            >
              <Star className="size-3.5 text-brand" /> {t("config.aboutRepo")}
            </a>
            <a
              href="https://career-ops.org"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-foreground max-sm:min-h-[44px]"
            >
              <ExternalLink className="size-3.5 text-brand" /> {t("config.aboutSite")}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 版本信息芯片：极小大写标签 + 值。mono 用于 sha/版本号，accent 给 pre-release 渠道上色。 */
function Chip({
  label,
  value,
  mono,
  accent,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
  title?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface/50 px-3 py-2.5" title={title}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">{label}</div>
      <div
        className={cn(
          "mt-1 truncate text-sm",
          accent ? "font-semibold text-brand-text" : "text-foreground",
          mono && "font-mono",
        )}
      >
        {value}
      </div>
    </div>
  );
}
