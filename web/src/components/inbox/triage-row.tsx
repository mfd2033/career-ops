"use client";

import { useRef, type MouseEvent } from "react";
import Link from "next/link";
import { Bookmark, BookmarkCheck, Coins, ExternalLink, Loader2, X } from "lucide-react";
import type { InboxJob } from "@/lib/career-ops";
import type { AtsSource } from "@/lib/explore";
import { ATS_LABEL } from "@/lib/explore";
import { openableUrl } from "@/lib/inbox-url.mjs";
import { isExemptClickTarget, isDragGesture, isTextSelectionActive } from "@/lib/row-click.mjs";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

export type RowScore = { score: number | null; tone: "good" | "warn" | "bad" | "muted"; jobId: string; running: boolean };

function agoLabel(
  age: number | null,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (age == null) return null;
  if (age <= 0) return t("inbox.today");
  if (age === 1) return t("inbox.yesterday");
  if (age < 7) return t("inbox.daysAgo", { n: age });
  if (age < 30) return t("inbox.weeksAgo", { n: Math.floor(age / 7) });
  return t("inbox.monthsAgo", { n: Math.floor(age / 30) });
}

// One raw posting in the triage list. Shows ONLY cheap, free signals + an honest
// "not scored" (CRUDA) — never a fake match%. Once its shortlist eval finishes it
// flips to EVALUADA (a real A–F badge). Save→shortlist / Skip→hidden are free + undoable.
export function TriageRow({
  job,
  source,
  age,
  scored,
  selected,
  shortlisted,
  onToggleSelect,
  onSave,
  onSkip,
}: {
  job: InboxJob;
  source: AtsSource | null;
  age: number | null;
  scored?: RowScore;
  selected: boolean;
  shortlisted: boolean;
  onToggleSelect: () => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  const { t } = useI18n();
  const ago = agoLabel(age, t);
  const evaluated = !!scored && (scored.running || scored.score != null);
  // ADR-0060 行点击选中：判定全在 row-click.mjs（纯函数已单测），这里只接线。
  // pointerdown 坐标供拖拽闸比对；行内控件（a/button/input）让路不劫持。
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  const onRowClick = (e: MouseEvent<HTMLElement>) => {
    if (isExemptClickTarget(e.target as Element)) return;
    if (isDragGesture(pointerDownRef.current, { x: e.clientX, y: e.clientY })) return;
    if (isTextSelectionActive(window.getSelection?.())) return;
    onToggleSelect();
  };

  return (
    <li
      onPointerDown={(e) => {
        pointerDownRef.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={onRowClick}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 px-3 py-2.5 transition-colors sm:gap-3 sm:px-4",
        selected ? "bg-brand-soft/50" : "hover:bg-surface-hover",
        evaluated && "opacity-95",
      )}
    >
      {/* multi-select — power-user batch to shortlist */}
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={t("inbox.selectAria", { company: job.company, role: job.role })}
        className="size-4 shrink-0 accent-brand max-sm:min-h-[44px] max-sm:min-w-[24px]"
      />

      <CompanyLogo name={job.company} size={20} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {openableUrl(job.url) ? (
            // Title IS the link to the original posting — largest hit area, new
            // tab, raw url verbatim (openableUrl deliberately does no https
            // upgrade: normalizeUrl's identity transform stays out of navigation).
            // The score badge's internal /jobs link coexists beside it.
            <a
              href={openableUrl(job.url)!}
              target="_blank"
              rel="noopener noreferrer"
              title={t("inbox.openPosting")}
              className="group text-foreground transition-colors hover:text-brand"
            >
              <span className="font-medium">{job.company}</span>
              <span className="text-muted group-hover:text-brand"> · {job.role}</span>
              <ExternalLink className="ml-1 inline size-3 align-[-1px] text-faint opacity-0 transition-opacity group-hover:opacity-100" />
            </a>
          ) : (
            <>
              <span className="font-medium text-foreground">{job.company}</span>
              <span className="text-muted"> · {job.role}</span>
            </>
          )}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
          {job.location && <span className="truncate">{job.location}</span>}
          {source && <span className="rounded bg-surface-hover px-1 py-px font-medium text-muted">{ATS_LABEL[source]}</span>}
          {ago && <span>{ago}</span>}
          {/* 收件箱薪资（ADR-0023）：note 尾段原文直出；解析不出月薪 → 并列追加
              「薪资未知」标记（与探索页卡片同口径：原文能拿到就直出，同时说明它
              不算数）。二者可同时出现（面议 / 元·天口径）。 */}
          {job.salaryText && (
            <span className="inline-flex items-center gap-0.5 font-medium text-muted">
              <Coins className="size-3" /> {job.salaryText}
            </span>
          )}
          {job.salaryUnknown && (
            <span
              className="inline-flex items-center gap-0.5 italic"
              title={t("explore.card.salaryUnknownTitle")}
            >
              <Coins className="size-3" /> {t("explore.card.salaryUnknown")}
            </span>
          )}
          {/* 🔴 CRUDA: honest "not scored" — no fabricated match%. */}
          {!evaluated && <span className="italic text-muted">{t("inbox.notScored")}</span>}
        </p>
      </div>

      {/* EVALUADA state (right-aligned, visually distinct from raw rows). A jobId
          links to the worker that produced the verdict; a PERSISTED score (jobId "")
          — evaluated outside this browser — renders a bare badge with no page to
          link to. */}
      {evaluated ? (
        scored!.running ? (
          <Link href={`/jobs/${scored!.jobId}`} className="flex shrink-0 items-center gap-1.5 text-xs">
            <Loader2 className="size-3.5 animate-spin text-brand" />
            <span className="text-brand max-sm:hidden">{t("inbox.scoring")}</span>
          </Link>
        ) : scored!.jobId ? (
          <Link href={`/jobs/${scored!.jobId}`} className="flex shrink-0 items-center gap-1.5 text-xs">
            <Badge tone={scored!.tone}>{scored!.score}/5</Badge>
          </Link>
        ) : (
          <Badge tone={scored!.tone}>{scored!.score}/5</Badge>
        )
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onSave}
            title={shortlisted ? t("inbox.inShortlist") : t("inbox.saveToShortlist")}
            aria-pressed={shortlisted}
            className={cn(
              "inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px] max-sm:min-w-[44px]",
              shortlisted ? "text-brand" : "text-muted hover:bg-surface-hover hover:text-brand",
            )}
          >
            {shortlisted ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
            <span className="max-sm:hidden">{shortlisted ? t("inbox.saved") : t("inbox.save")}</span>
          </button>
          <button
            type="button"
            onClick={onSkip}
            title={t("inbox.skipTitle")}
            className="inline-flex items-center justify-center rounded-md p-1 text-faint transition-colors hover:bg-surface-hover hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </li>
  );
}
