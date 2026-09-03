"use client";

import Link from "next/link";
import { ArrowLeft, FileText, ExternalLink, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
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
  prev = null,
  next = null,
  position = null,
  total = null,
  contextQuery = "",
}: {
  id: string;
  app: Application | null;
  report: string | null;
  /** kept in the props contract (the page passes it) but no longer surfaced —
   *  the raw .md filename is a dev artifact, not header content. */
  file?: string | null;
  canDelete?: boolean;
  /** Previous/next report in the list page's ordered context (null at the
   *  boundaries, where the control is disabled). */
  prev?: Application | null;
  next?: Application | null;
  /** 1-based position of this report within the ordered list, or null when the
   *  report isn't in any ordered list (rare). Renders the "3 / 12" indicator. */
  position?: number | null;
  total?: number | null;
  /** Query string carrying the list context (tab/min/sort/dir/q) — appended to
   *  the back + prev/next links so a round-trip returns to the SAME view. */
  contextQuery?: string;
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
      "Summary": t("pipeline.section.summary"),
      "Skill Matching Table": t("pipeline.section.skillMatchingTable"),
      "Gap Analysis": t("pipeline.section.gapAnalysis"),
      "Level Detected": t("pipeline.section.levelDetected"),
      "Company Type": t("pipeline.section.companyType"),
      "Compensation Research": t("pipeline.section.compensationResearch"),
      "Compensation Reliability": t("pipeline.section.compensationReliability"),
      "Pay-Transparency Range-Width Signal": t("pipeline.section.payTransparencySignal"),
      "Why Not": t("pipeline.section.whyNot"),
      "If Proceeding Anyway (Not Recommended)": t("pipeline.section.ifProceedingAnyway"),
      "Signals": t("pipeline.section.signals"),
      "Key Concerns": t("pipeline.section.keyConcerns"),
      "Verdict": t("pipeline.section.verdict"),
      "Gaps": t("pipeline.section.gaps"),
      // Chinese headings from various AI models
      "职位概述": t("pipeline.section.roleSummary"),
      "简历匹配度": t("pipeline.section.matchWithCv"),
      "策略建议": t("pipeline.section.strategy"),
      "职级与策略": t("pipeline.section.levelAndStrategy"),
      "薪酬分析": t("pipeline.section.compensation"),
      "薪酬与需求": t("pipeline.section.compAndDemand"),
      "个性化备注": t("pipeline.section.personalization"),
      "定制方案": t("pipeline.section.customizationPlan"),
      "面试准备": t("pipeline.section.interviewPrep"),
      "面试计划": t("pipeline.section.interviewPlan"),
      "招聘信息真实性": t("pipeline.section.postingLegitimacy"),
      "风险摘要": t("pipeline.section.riskSummary"),
      "求职信草稿": t("pipeline.section.coverLetterDraft"),
      "提取的关键词": t("pipeline.section.keywordsExtracted"),
      "评分（1-5）": t("pipeline.section.scoring"),
      "机器摘要": t("pipeline.section.machineSummary"),
      "已提交": t("pipeline.section.submitted"),
      "提交日志": t("pipeline.section.submitLog"),
      "申请答案": t("pipeline.section.applicationAnswers"),
      "申请答案草稿": t("pipeline.section.draftApplicationAnswers"),
      "摘要": t("pipeline.section.summary"),
      "技能匹配表": t("pipeline.section.skillMatchingTable"),
      "差距分析": t("pipeline.section.gapAnalysis"),
      "职级判定": t("pipeline.section.levelDetected"),
      "公司类型": t("pipeline.section.companyType"),
      "薪酬调研": t("pipeline.section.compensationResearch"),
      "薪酬可靠性": t("pipeline.section.compensationReliability"),
      "薪资透明度范围信号": t("pipeline.section.payTransparencySignal"),
      "为何不建议": t("pipeline.section.whyNot"),
      "若仍考虑（不推荐）": t("pipeline.section.ifProceedingAnyway"),
      "信号": t("pipeline.section.signals"),
      "关键顾虑": t("pipeline.section.keyConcerns"),
      "结论": t("pipeline.section.verdict"),
      "差距": t("pipeline.section.gaps"),
      // More Chinese headings from varied AI outputs
      "总览": t("pipeline.section.summary"),
      "配套交付": t("pipeline.section.customizationPlan"),
      "对比表": t("pipeline.section.skillMatchingTable"),
      "建议优先级（若推进投递）": t("pipeline.section.ifProceedingAnyway"),
      "关键洞察": t("pipeline.section.keyConcerns"),
      "JD 要求 → cv.md 证据映射": t("pipeline.section.matchWithCv"),
      "JD 要求 → cv.md 映射": t("pipeline.section.matchWithCv"),
      "CV 改动": t("pipeline.section.customizationPlan"),
      "LinkedIn/个人简介 改动": t("pipeline.section.customizationPlan"),
      "STAR+R 故事表": t("pipeline.section.interviewPlan"),
      "匹配表": t("pipeline.section.matchWithCv"),
      "Gaps 与缓解策略": t("pipeline.section.gapAnalysis"),
      "级别评估": t("pipeline.section.levelDetected"),
      "公司分类": t("pipeline.section.companyType"),
      "薪资分析": t("pipeline.section.compensation"),
      "关键发现": t("pipeline.section.keyConcerns"),
      "推荐故事": t("pipeline.section.interviewPlan"),
      "推荐案例研究": t("pipeline.section.interviewPlan"),
      "红旗问题应对": t("pipeline.section.interviewPlan"),
      "信号分析": t("pipeline.section.signals"),
      "评估结论": t("pipeline.section.verdict"),
      "合法性总结": t("pipeline.section.postingLegitimacy"),
      "综合评估": t("pipeline.section.summary"),
      "评分汇总": t("pipeline.section.scoring"),
      "建议动作": t("pipeline.section.strategy"),
      "HR验证问题（如薪资可达底线时）": t("pipeline.section.compensation"),
      "最终建议": t("pipeline.section.verdict"),
      "工作授权检查": t("pipeline.section.postingLegitimacy"),
      "地理位置检查": t("pipeline.section.postingLegitimacy"),
      "地理不匹配检查": t("pipeline.section.postingLegitimacy"),
      // Additional English variants
      "If They Downlevel": t("pipeline.section.ifProceedingAnyway"),
      "Geo-mismatch check": t("pipeline.section.postingLegitimacy"),
      "Work-authorization check": t("pipeline.section.postingLegitimacy"),
      "Assessment": t("pipeline.section.verdict"),
      "CV 改动（5项）": t("pipeline.section.customizationPlan"),
      "LinkedIn / 个人简介 5 项改动": t("pipeline.section.customizationPlan"),
      "LinkedIn优化（前5项）": t("pipeline.section.customizationPlan"),
      "LinkedIn / 个人简介改动（5项）": t("pipeline.section.customizationPlan"),
      "信号表": t("pipeline.section.signals"),
      "评估：High Confidence": t("pipeline.legitimacy.highConfidence"),
      "JD 要求（职责，已渲染）→ cv.md 证据映射": t("pipeline.section.matchWithCv"),
      "Gap 分析": t("pipeline.section.gapAnalysis"),
      "合法性评估": t("pipeline.section.postingLegitimacy"),
      "综合评分说明": t("pipeline.section.scoring"),
      "评分": t("pipeline.section.scoring"),
      "Gaps（逐条判断）": t("pipeline.section.gaps"),
      "等级检测": t("pipeline.section.levelDetected"),
      "地理位置不匹配检查": t("pipeline.section.postingLegitimacy"),
      "公司类型分类": t("pipeline.section.companyType"),
      "需求趋势": t("pipeline.section.compAndDemand"),
      "薪资对比": t("pipeline.section.compensation"),
      "HR 核实问题": t("pipeline.section.compensation"),
      "定制化计划": t("pipeline.section.customizationPlan"),
      "面试STAR+R计划": t("pipeline.section.interviewPlan"),
      "招聘真实性评估": t("pipeline.section.postingLegitimacy"),
      "综合评分与建议": t("pipeline.section.summary"),
      "ATS 关键词提取": t("pipeline.section.extractedKeywords"),
      "块A - 角色摘要": t("pipeline.section.roleSummary"),
      "块B - 与CV匹配": t("pipeline.section.matchWithCv"),
      "块C - 级别与策略": t("pipeline.section.levelAndStrategy"),
      "块D - 薪酬与需求": t("pipeline.section.compAndDemand"),
      "块E - 定制计划": t("pipeline.section.customizationPlan"),
      "块F - 面试计划": t("pipeline.section.interviewPlan"),
      "块G - 职位合法性": t("pipeline.section.postingLegitimacy"),
      "最终评分": t("pipeline.section.scoring"),
      "Strengths": t("pipeline.section.matchWithCv"),
      "Level Detection": t("pipeline.section.levelDetected"),
      "推销资深但不撒谎策略": t("pipeline.section.strategy"),
      "被降级应对策略": t("pipeline.section.ifProceedingAnyway"),
      "Market Data (Research Budget: 5 queries used 0)": t("pipeline.section.compensation"),
      "HR Verification Questions": t("pipeline.section.compensation"),
      "Top 5 CV Changes": t("pipeline.section.customizationPlan"),
      "Top 5 LinkedIn Changes": t("pipeline.section.customizationPlan"),
      "Recommended Case Study": t("pipeline.section.interviewPlan"),
      "Red-flag Questions": t("pipeline.section.interviewPlan"),
      "Signals Table": t("pipeline.section.signals"),
      "Market Data (郑州IT项目经理/总监)": t("pipeline.section.compensation"),
      "Demand Trend": t("pipeline.section.compAndDemand"),
      "Red-flag Questions and Answers": t("pipeline.section.interviewPlan"),
      "Signals Analysis": t("pipeline.section.signals"),
      "Legitimacy Tier: **Proceed with Caution**": t("pipeline.legitimacy.proceedCaution"),
      "Company classification": t("pipeline.section.companyType"),
      "Compensation breakdown": t("pipeline.section.compensation"),
      "Gap analysis": t("pipeline.section.gapAnalysis"),
      "Market demand": t("pipeline.section.compAndDemand"),
      "HR verification questions": t("pipeline.section.compensation"),
      "Assessment: **Proceed with Caution**": t("pipeline.legitimacy.proceedCaution"),
      "LinkedIn Changes": t("pipeline.section.customizationPlan"),
      "Prior-contact FYI": t("pipeline.section.postingLegitimacy"),
      "3. \"If they downlevel me\" 计策": t("pipeline.section.ifProceedingAnyway"),
      "Red-flag Questions & Answers": t("pipeline.section.interviewPlan"),
      "Assessment: Proceed with Caution": t("pipeline.legitimacy.proceedCaution"),
      "Legitimacy Tier": t("pipeline.section.postingLegitimacy"),
      "Recommendations": t("pipeline.section.strategy"),
      "LinkedIn优化": t("pipeline.section.customizationPlan"),
      "先前联系FYI": t("pipeline.section.postingLegitimacy"),
      "\"Sell Senior Without Lies\" Plan": t("pipeline.section.strategy"),
      "\"If They Downlevel Me\" Plan": t("pipeline.section.ifProceedingAnyway"),
      "Market Context (郑州项目经理)": t("pipeline.section.compensation"),
      "差距与缓解策略": t("pipeline.section.gapAnalysis"),
      "Mapping": t("pipeline.section.matchWithCv"),
      "Salary Research": t("pipeline.section.compensationResearch"),
      "STAR+R Stories": t("pipeline.section.interviewPlan"),
      "Signals Analyzed": t("pipeline.section.signals"),
      "Company type classification": t("pipeline.section.companyType"),
      "Compensation reliability": t("pipeline.section.compensationReliability"),
      "Required HR verification questions": t("pipeline.section.compensation"),
      "Top 5 changes to LinkedIn": t("pipeline.section.customizationPlan"),
      "Signals table": t("pipeline.section.signals"),
      "Overall judgment": t("pipeline.section.verdict"),
      "Market data": t("pipeline.section.compensation"),
      "Demand trend": t("pipeline.section.compAndDemand"),
      "Recommended case study": t("pipeline.section.interviewPlan"),
      "Red-flag questions": t("pipeline.section.interviewPlan"),
      "8. Benefits/Employment Terminology Country Mismatch": t("pipeline.section.postingLegitimacy"),
      "9. Third-Party Platform Location Tag vs. Employer's Own Posting Mismatch": t("pipeline.section.postingLegitimacy"),
      "10. Agency Licensing Check": t("pipeline.section.postingLegitimacy"),
      "11. Immigration-Status Requirement Overreach": t("pipeline.section.postingLegitimacy"),
      "12. Jurisdiction-Prohibited Content": t("pipeline.section.postingLegitimacy"),
      "13. Pay-Transparency Range-Width Check": t("pipeline.section.payTransparencySignal"),
      "14. Minimum-Wage Lawyer Question": t("pipeline.section.postingLegitimacy"),
      "15. AI-Screening Disclosure": t("pipeline.section.postingLegitimacy"),
      "Block G Verdict": t("pipeline.section.postingLegitimacy"),
      "检测到的级别": t("pipeline.section.levelDetected"),
      "以资深定位但不虚报策略": t("pipeline.section.strategy"),
      "如果被降级策略": t("pipeline.section.ifProceedingAnyway"),
      "评估": t("pipeline.section.verdict"),
      "Step 0 — 原型检测": t("pipeline.section.postingLegitimacy"),
      "CV匹配表": t("pipeline.section.matchWithCv"),
      "⚠️ 关键矛盾：编码能力要求": t("pipeline.section.keyConcerns"),
      "CV匹配": t("pipeline.section.matchWithCv"),
      "Gaps与缓解策略": t("pipeline.section.gapAnalysis"),
      "CV定制计划": t("pipeline.section.customizationPlan"),
      "CV 匹配": t("pipeline.section.matchWithCv"),
      "定制计划": t("pipeline.section.customizationPlan"),
      "角色摘要 (Role Summary)": t("pipeline.section.roleSummary"),
      "与 CV 匹配 (CV Match)": t("pipeline.section.matchWithCv"),
      "级别与策略 (Level and Strategy)": t("pipeline.section.levelAndStrategy"),
      "薪酬与需求 (Compensation and Demand)": t("pipeline.section.compAndDemand"),
      "个性化方案 (Personalization Plan)": t("pipeline.section.customizationPlan"),
      "面试准备 (Interview Plan)": t("pipeline.section.interviewPlan"),
      "招聘真实性 (Posting Legitimacy)": t("pipeline.section.postingLegitimacy"),
      "Block A — Role Summary": t("pipeline.section.roleSummary"),
      "1. Posting Freshness": t("pipeline.section.postingLegitimacy"),
      "2. Description Quality": t("pipeline.section.postingLegitimacy"),
      "3. Company Hiring Signals": t("pipeline.section.postingLegitimacy"),
      "4. Reposting Detection": t("pipeline.section.postingLegitimacy"),
      "5. Role Market Context": t("pipeline.section.postingLegitimacy"),
      "6. Employment Classification Risk": t("pipeline.section.postingLegitimacy"),
      "7. AI-Buzzword vs. Infrastructure Mismatch": t("pipeline.section.postingLegitimacy"),
      "8-15": t("pipeline.section.postingLegitimacy"),
      "岗位概览": t("pipeline.section.roleSummary"),
      "岗位匹配度": t("pipeline.section.matchWithCv"),
      "层级与策略": t("pipeline.section.levelAndStrategy"),
      "岗位真实性": t("pipeline.section.postingLegitimacy"),
      "风险总结": t("pipeline.section.riskSummary"),
      "角色概览": t("pipeline.section.roleSummary"),
      "简历匹配分析": t("pipeline.section.matchWithCv"),
      "级别判断与求职策略": t("pipeline.section.levelAndStrategy"),
      "薪酬竞争力与市场需求": t("pipeline.section.compAndDemand"),
      "针对性定制方案": t("pipeline.section.customizationPlan"),
      "面试备考计划": t("pipeline.section.interviewPlan"),
      "职位真实性评估": t("pipeline.section.postingLegitimacy"),
      "原型检测": t("pipeline.section.postingLegitimacy"),
      "资历 / 层级错配": t("pipeline.section.levelDetected"),
      "与 CV 的匹配": t("pipeline.section.matchWithCv"),
      "发布真实性（Posting Legitimacy）": t("pipeline.section.postingLegitimacy"),
      "Output format": t("pipeline.section.postingLegitimacy"),
      "Prior-contact FYI（non-scoring）": t("pipeline.section.postingLegitimacy"),
      "Edge case handling": t("pipeline.section.postingLegitimacy"),
      "角色摘要": t("pipeline.section.roleSummary"),
      "地理位置一致性检查": t("pipeline.section.postingLegitimacy"),
      "与 CV 匹配分析": t("pipeline.section.matchWithCv"),
      "需求映射": t("pipeline.section.matchWithCv"),
      "缺口分析": t("pipeline.section.gapAnalysis"),
      "级别与策略": t("pipeline.section.levelAndStrategy"),
      "1. 级别对比": t("pipeline.section.levelDetected"),
      "展示资历而不说谎策略": t("pipeline.section.strategy"),
      "被降级应对计划": t("pipeline.section.ifProceedingAnyway"),
      "薪资可靠性": t("pipeline.section.compensationReliability"),
      "发布合法性": t("pipeline.section.postingLegitimacy"),
      "上下文备注": t("pipeline.section.postingLegitimacy"),
      "与简历匹配": t("pipeline.section.matchWithCv"),
      "面试方案": t("pipeline.section.interviewPlan"),
      "提取关键词": t("pipeline.section.extractedKeywords"),
      "个性化方案": t("pipeline.section.customizationPlan"),
      "资历与策略": t("pipeline.section.levelAndStrategy"),
      "薪资与需求": t("pipeline.section.compAndDemand"),
      "招聘真实性": t("pipeline.section.postingLegitimacy"),
      "与CV匹配": t("pipeline.section.matchWithCv"),
      "薪酬与需求 (Comp and Demand)": t("pipeline.section.compAndDemand"),
      "总体判断": t("pipeline.section.verdict"),
      "职位概览": t("pipeline.section.roleSummary"),
      "薪酬研究": t("pipeline.section.compensationResearch"),
      "HR验证问题": t("pipeline.section.compensation"),
      "CV调整（前5项）": t("pipeline.section.customizationPlan"),
      "LinkedIn调整（前5项）": t("pipeline.section.customizationPlan"),
      "STAR+R故事": t("pipeline.section.interviewPlan"),
      "红旗问题及回答": t("pipeline.section.interviewPlan"),
      "帖子合法性": t("pipeline.section.postingLegitimacy"),
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
    <div className="w-full px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/pipeline${contextQuery}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
        >
          <ArrowLeft className="size-4" /> {t("pipeline.report.backToPipeline")}
        </Link>

        {position != null && (
          <nav aria-label={t("pipeline.report.navigation")} className="flex items-center gap-1.5">
            {prev ? (
              <Link
                href={`/pipeline/${prev.n}${contextQuery}`}
                className="inline-flex min-w-0 max-w-56 items-center gap-1 rounded-lg border border-border bg-surface/60 px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-brand/40 hover:text-brand"
                title={t("pipeline.report.previous", { company: prev.company })}
              >
                <ChevronLeft className="size-4 shrink-0" />
                <span className="truncate">{t("pipeline.report.previous", { company: prev.company })}</span>
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-surface/30 px-2.5 py-1.5 text-sm text-faint/60 opacity-60"
                title={t("pipeline.report.previousNone")}
              >
                <ChevronLeft className="size-4 shrink-0" />
                <span className="truncate">{t("pipeline.report.previousNone")}</span>
              </span>
            )}

            <span className="px-1 text-xs text-faint tabular-nums" aria-live="polite">
              {t("pipeline.report.position", { pos: position, total: total ?? position })}
            </span>

            {next ? (
              <Link
                href={`/pipeline/${next.n}${contextQuery}`}
                className="inline-flex min-w-0 max-w-56 items-center gap-1 rounded-lg border border-border bg-surface/60 px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-brand/40 hover:text-brand"
                title={t("pipeline.report.next", { company: next.company })}
              >
                <span className="truncate">{t("pipeline.report.next", { company: next.company })}</span>
                <ChevronRight className="size-4 shrink-0" />
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-surface/30 px-2.5 py-1.5 text-sm text-faint/60 opacity-60"
                title={t("pipeline.report.nextNone")}
              >
                <span className="truncate">{t("pipeline.report.nextNone")}</span>
                <ChevronRight className="size-4 shrink-0" />
              </span>
            )}
          </nav>
        )}
      </div>

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
