"use client";

import Link from "next/link";
import { ArrowLeft, FileText, ExternalLink, ChevronDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Application } from "@/lib/career-ops";
import { Badge } from "@/components/ui/badge";
import { scoreTone, scoreNum, legitimacyTone, parseReport } from "@/lib/format";
import { cleanHeading, splitSections } from "@/lib/report-sections.mjs";
import { StatusSelect } from "@/components/status-select";
import { CompanyLogo } from "@/components/company-logo";
import { ScoreMethodology } from "@/components/score-methodology";
import { GeneratePdfButton } from "@/components/generate-pdf-button";
import { ReevaluateButton } from "@/components/reevaluate-button";
import { OpenCvFolderButton } from "@/components/open-cv-folder-button";
import { ApplyButton } from "@/components/apply-button";
import { DeleteFromTracker } from "@/components/delete-from-tracker";
import { SkipFromTracker } from "@/components/skip-from-tracker";
import { useI18n } from "@/lib/i18n/context";

// Progressive disclosure of the report. The core writes prose blocks
// "## F) Verdict (lead)", "## A) Role Summary", "## B) Match with CV", then
// the remaining lettered blocks + machine artifacts (Machine Summary YAML,
// Application Answers, submit log). A mainstream user deciding "should I
// apply?" needs the verdict + fit; the rest is depth-on-demand. We lead with
// the verdict as a callout, keep A/B expanded, collapse the other lettered
// blocks as content, and drop machine artifacts to a dimmer "Technical" tier —
// and strip the bare "F)" author-letters from headings (native <details>, no
// client JS — this stays a server component).
//
// Splitting and heading cleanup live in lib/report-sections.mjs so the
// author-letter range has one definition; duplicating it here is what left
// "H) Draft Application Answers" rendering with its letter attached (#2324).

// Machine artifacts (collapsed because they're for devs, not the mainstream) vs
// human content C–G (collapsed only for length) — ux's "honest for devs" tier.
function isMachine(heading: string): boolean {
  return /machine summary|submitted|submit[-\s]?log/i.test(heading);
}

// A one-line teaser for a collapsed content section — drops the interaction cost
// of "what's in here?" without defeating the collapse.
function preview(md: string): string {
  const text = md
    .replace(/^#+\s.*$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return sentence.length > 96 ? sentence.slice(0, 96).trimEnd() + "…" : sentence;
}

export function ReportView({
  id,
  app,
  report,
  canDelete = false,
}: {
  id: string;
  app: Application | null;
  report: string | null;
  /** kept in the props contract (the page passes it) but no longer surfaced —
   *  the raw .md filename is a dev artifact, not header content. */
  file?: string | null;
  canDelete?: boolean;
}) {
  const { t } = useI18n();
  const translateSectionHeading = (heading: string): string => {
    const map: Record<string, string> = {
      "Role Summary": t("pipeline.section.roleSummary"),
      "Match with CV": t("pipeline.section.matchWithCv"),
      "Strategy": t("pipeline.section.strategy"),
      "Level and Strategy": t("pipeline.section.levelAndStrategy"),
      "Compensation": t("pipeline.section.compensation"),
      "Comp and Demand": t("pipeline.section.compAndDemand"),
      "Personalization": t("pipeline.section.personalization"),
      "Customization Plan": t("pipeline.section.customizationPlan"),
      "Interview Prep": t("pipeline.section.interviewPrep"),
      "Interview Plan": t("pipeline.section.interviewPlan"),
      "Posting Legitimacy": t("pipeline.section.postingLegitimacy"),
      "Risk Summary": t("pipeline.section.riskSummary"),
      "Cover Letter Draft": t("pipeline.section.coverLetterDraft"),
      "Keywords extracted": t("pipeline.section.keywordsExtracted"),
      "Extracted Keywords": t("pipeline.section.extractedKeywords"),
      "Scoring（1-5）": t("pipeline.section.scoring"),
      "Machine Summary": t("pipeline.section.machineSummary"),
      "Submitted": t("pipeline.section.submitted"),
      "Submit Log": t("pipeline.section.submitLog"),
      "Application Answers": t("pipeline.section.applicationAnswers"),
      "Draft Application Answers": t("pipeline.section.draftApplicationAnswers"),
    };
    return map[heading] ?? heading;
  };
  const translateLegitimacy = (value: string): string => {
    const map: Record<string, string> = {
      "High Confidence": t("pipeline.legitimacy.highConfidence"),
      "Medium Confidence": t("pipeline.legitimacy.mediumConfidence"),
      "Low Confidence": t("pipeline.legitimacy.lowConfidence"),
      "Caution": t("pipeline.legitimacy.caution"),
      "Proceed with Caution": t("pipeline.legitimacy.proceedCaution"),
      "Suspicious": t("pipeline.legitimacy.suspicious"),
    };
    if (map[value]) return map[value];
    // 带附注的变体（如 "High Confidence（含发布新鲜度提示，见 Block G）"）——
    // 按最长前缀归类翻译，附注原文保留在译文之后。
    const prefix = Object.keys(map)
      .filter((k) => value.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return prefix ? `${map[prefix]}${value.slice(prefix.length)}` : value;
  };
  const meta = report ? parseReport(report) : null;
  const field = (label: string) => meta?.fields.find((f) => f.label === label)?.value;
  const score = app?.score || field("Score");
  // The tracker Date column keeps the INITIAL evaluation date (#2808, 方向 A);
  // the report's own `Date:` header is the date THIS report was written — for a
  // re-evaluated row that is the fresh re-eval date. Show both when they differ
  // so the page reflects "evaluated 08-23 · re-evaluated 09-01" without moving
  // the tracker's initial date.
  const date = app?.date || field("Date");
  const revalDate = field("Date");
  const showReval = Boolean(revalDate && app?.date && revalDate !== app.date);
  const archetype = field("Archetype");
  const url = field("URL");
  const pdfReady = (app?.pdf ?? "").includes("✅");

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link
        href="/pipeline"
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
      >
        <ArrowLeft className="size-4" /> {t("pipeline.report.backToPipeline")}
      </Link>

      <header className="mt-5">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-faint">#{id}</p>
        <div className="mt-2 flex items-center gap-3">
          <CompanyLogo name={app?.company ?? meta?.title ?? `Report #${id}`} size={40} />
          <h1 className="font-display text-3xl tracking-tight text-landing">
            {app?.company ?? meta?.title ?? `Report #${id}`}
          </h1>
        </div>
        {app?.role && <p className="mt-1 text-muted">{app.role}</p>}

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          {score && <Badge tone={scoreTone(score)}>{score}</Badge>}
          {/* Verdict-first: the score's apply/don't-apply call (4.0 is the line,
              per the public methodology) as a <2s-scannable chip. */}
          {(() => {
            const n = scoreNum(score ?? "");
            if (Number.isNaN(n)) return null;
            return n >= 4.0 ? <Badge tone="good">{t("pipeline.report.recommended")}</Badge> : <Badge tone="muted">{t("pipeline.report.belowApplyLine")}</Badge>;
          })()}
          {meta?.legitimacy && <Badge tone={legitimacyTone(meta.legitimacy)}>{translateLegitimacy(meta.legitimacy)}</Badge>}
          {app && <StatusSelect n={id} current={app.status} />}
          {app && app.status !== "Discarded" && <SkipFromTracker n={id} />}
          <GeneratePdfButton n={id} company={app?.company ?? meta?.title ?? id} pdfReady={pdfReady} />
          <ReevaluateButton id={id} url={url && url.startsWith("http") ? url : undefined} company={app?.company ?? meta?.title ?? id} />
          {pdfReady && <OpenCvFolderButton company={app?.company ?? meta?.title ?? id} />}
          <ApplyButton n={id} url={url && url.startsWith("http") ? url : undefined} company={app?.company ?? meta?.title ?? id} pdfReady={pdfReady} />
        </div>

        {app && canDelete && (
          <div className="mt-3">
            <DeleteFromTracker n={id} />
          </div>
        )}

        {(archetype || date || (url && url.startsWith("http"))) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            {archetype && <span className="max-w-full truncate">{archetype}</span>}
            {date && (
              <span className="tabular-nums text-faint">
                {showReval ? t("pipeline.report.evalDates", { date, reval: revalDate ?? "" }) : date}
              </span>
            )}
            {url && url.startsWith("http") && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-1 text-brand hover:underline max-sm:min-h-[44px]"
              >
                {t("pipeline.report.posting")} <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        )}
      </header>

      {report ? (
        <>
          {(() => {
            const { intro, sections } = splitSections(meta?.body ?? report);
            // Tolerant fallback: unrecognized layout → render the whole body as
            // before, so an old/odd report never loses content.
            if (sections.length === 0) {
              return (
                <article className="report-prose mt-8">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{meta?.body ?? report}</ReactMarkdown>
                </article>
              );
            }
            // Verdict (F) leads as a highlighted callout with no competing heading —
            // it's THE answer. A/B stay expanded (fit detail); C–G collapse as
            // content (with a 1-line preview); machine artifacts drop to a dimmer
            // "Technical" tier so the CLI-DNA is present-but-clearly-secondary.
            const verdict = sections.find((s) => s.letter === "F");
            const rest = sections.filter((s) => s !== verdict);
            const machine = rest.filter((s) => isMachine(s.heading));
            const mainSections = rest.filter((s) => !isMachine(s.heading));
            const anyAB = mainSections.some((s) => s.letter === "A" || s.letter === "B");
            return (
              <div className="mt-8">
                {intro && (
                  <article className="report-prose">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{intro}</ReactMarkdown>
                  </article>
                )}

                {verdict && (
                  <div className="rounded-2xl border border-brand/25 bg-brand-soft/50 px-5 py-4">
                    <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.16em] text-brand/80">{t("pipeline.report.verdict")}</p>
                    <article className="report-prose [&_p]:font-medium [&_p]:text-foreground">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{verdict.content}</ReactMarkdown>
                    </article>
                  </div>
                )}

                {mainSections.map((s, i) => {
                  const expanded = s.letter === "A" || s.letter === "B" || (!anyAB && i === 0);
                  if (expanded) {
                    return (
                      <article key={i} className="report-prose mt-6">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{`## ${translateSectionHeading(cleanHeading(s.heading))}\n\n${s.content}`}</ReactMarkdown>
                      </article>
                    );
                  }
                  return (
                    <details key={i} className="group mt-3 overflow-hidden rounded-xl border border-border bg-surface/30">
                      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 py-3 transition-colors hover:bg-surface-hover">
                        <span className="text-sm font-medium">{translateSectionHeading(cleanHeading(s.heading))}</span>
                        <span className="hidden truncate text-xs text-faint sm:inline">{preview(s.content)}</span>
                        <ChevronDown className="ml-auto size-4 shrink-0 text-faint transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="report-prose border-t border-border px-4 py-3">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.content}</ReactMarkdown>
                      </div>
                    </details>
                  );
                })}

                {machine.length > 0 && (
                  <>
                    <div className="mt-6 flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-faint">
                      <span className="h-px flex-1 bg-border" />
                      {t("pipeline.report.technicalDetails")}
                      <span className="h-px flex-1 bg-border" />
                    </div>
                    {machine.map((s, i) => (
                      <details key={i} className="group mt-2 overflow-hidden rounded-xl border border-border/60 bg-surface/20">
                        <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 py-3 font-mono text-xs text-muted transition-colors hover:bg-surface-hover">
                          {translateSectionHeading(cleanHeading(s.heading))}
                          <ChevronDown className="ml-auto size-4 shrink-0 text-faint transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="report-prose border-t border-border/60 px-4 py-3 opacity-80">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.content}</ReactMarkdown>
                        </div>
                      </details>
                    ))}
                  </>
                )}
              </div>
            );
          })()}
          <ScoreMethodology />
        </>
      ) : (
        <div className="mt-8 flex items-center gap-3 rounded-2xl border border-dashed border-border bg-surface/30 p-5 text-sm text-muted">
          <FileText className="size-5 shrink-0 text-faint" />
          {t("pipeline.report.noReport", { id })}
        </div>
      )}
    </div>
  );
}
