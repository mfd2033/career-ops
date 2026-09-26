"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, ChevronsUpDown, X, Compass, ArrowRight, RotateCcw, Loader2, SkipForward, HeartPulse } from "lucide-react";
import type { Application, InboxJob } from "@/lib/career-ops";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { RowSlot } from "@/components/row-slot";
import { canonStatus, fmtDuration, scoreTone, statusDot, checkupTone } from "@/lib/format";
import type { CheckupEntry } from "@/lib/format";
import { CHECKUP_RISK_LABELS } from "@/lib/company-checkups.mjs";
import { orderApplications, buildContextQuery, countSelectedOffView } from "@/lib/pipeline-order.mjs";
import { normalizeUrl } from "@/lib/core/url-key.mjs";
// 报告薪资（ADR-0037）：列里显示归一化月薪区间，字段原文进悬停提示。
import { formatSalaryRange } from "@/lib/report-salary.mjs";
import { sourceLabel } from "@/lib/source-label.mjs";
import { InboxTriage } from "@/components/inbox/inbox-triage";
import { useJobs } from "@/components/jobs/job-store";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";
import { useUnknownEmployerPolicy } from "@/lib/use-unknown-employer";
import { resolveCompanyLabel } from "@/lib/unknown-employer.mjs";

// INBOX (the triage queue) is the default tab; the rest filter the tracker.
const TABS = [
  "INBOX",
  "ALL",
  "EVALUATED",
  "APPLIED",
  "RESPONDED",
  "INTERVIEW",
  "OFFER",
  "HIRED",
  "REJECTED",
  "DISCARDED",
  "SKIP",
] as const;
type Tab = (typeof TABS)[number];

// Column order == this array's order (the header and the body both follow it):
// salary (报告薪资, ADR-0037) sits right after score — the two numbers a user
// trades off against each other; checkup (体检★, ADR-0064) follows salary so
// all three evaluative numbers stay adjacent in one band.
const SORT_KEYS = ["company", "role", "score", "salary", "checkup", "duration", "status", "date"] as const;
type SortKey = (typeof SORT_KEYS)[number];

export function PipelineView({
  applications,
  inbox,
  scoredUrls,
  checkups,
}: {
  applications: Application[];
  inbox: InboxJob[];
  scoredUrls?: Record<string, { score: string }>;
  /** 公司体检 (ADR-0025): tracker# → latest checkup. Absent/empty → no badges
   *  (graceful degradation). Feeds the ★ badge, the 体检 column, and the
   *  checkup sort key (ADR-0064) — never filter, score, or any gate. */
  checkups?: Record<string, CheckupEntry>;
}) {
  // Tooltip text for one tracker#'s checkup badge: star, date, zh risk labels,
  // history when re-checked. No entry → null (badge not rendered).
  const checkupTitle = (n: string): string | null => {
    const c = checkups?.[n];
    if (!c) return null;
    const risks = c.risks.map((r) => (CHECKUP_RISK_LABELS as Record<string, string>)[r] ?? r).join(" / ");
    const parts = [`公司体检 ★${c.star.toFixed(1)}（${c.date}）`];
    if (risks) parts.push(risks);
    if (c.note) parts.push(c.note);
    if (c.count > 1) parts.push(`共 ${c.count} 次（最低 ★${c.minStar.toFixed(1)}）`);
    return parts.join(" · ");
  };
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  // 未知雇主策略（挂载后读取，避免 SSR/hydration 不一致）。与详情页共用同一条显示规则，
  // 所以 `?` 行在列表里也会显示成「{代招方}（代招）」而不是一个孤零零的问号。
  const employerPolicy = useUnknownEmployerPolicy();
  const companyLabel = (r: Application) =>
    resolveCompanyLabel({ company: r.company, agency: r.reportVia, policy: employerPolicy });

  // Display labels for tabs/sort keys/statuses. The URL param values stay the
  // canonical English strings; only the visible text is localized.
  const TAB_LABELS: Record<Tab, string> = {
    INBOX: t("pipeline.tab.inbox"),
    ALL: t("pipeline.tab.all"),
    EVALUATED: t("pipeline.tab.evaluated"),
    APPLIED: t("pipeline.tab.applied"),
    RESPONDED: t("pipeline.tab.responded"),
    INTERVIEW: t("pipeline.tab.interview"),
    OFFER: t("pipeline.tab.offer"),
    HIRED: t("pipeline.tab.hired"),
    REJECTED: t("pipeline.tab.rejected"),
    DISCARDED: t("pipeline.tab.discarded"),
    SKIP: t("pipeline.tab.skip"),
  };
  const SORT_LABELS: Record<SortKey, string> = {
    company: t("pipeline.col.company"),
    role: t("pipeline.col.role"),
    score: t("pipeline.col.score"),
    salary: t("pipeline.col.salary"),
    checkup: t("pipeline.col.checkup"),
    duration: t("pipeline.col.duration"),
    status: t("pipeline.col.status"),
    date: t("pipeline.col.date"),
  };
  const statusLabel = (s: string) => {
    const key = `pipeline.status.${s.toLowerCase()}`;
    const v = t(key);
    return v === key ? s : v;
  };

  // The URL is the SINGLE source of truth for tab/min/max/sort/dir, so the home stat
  // tiles' deep links, the analytics drilldown links (ADR-0067) AND the assistant's
  // filterPipeline/navigate actions drive
  // the table identically (no useState mirror → no desync).
  const pTab = (params.get("tab") ?? "").toUpperCase();
  const tab: Tab = (TABS as readonly string[]).includes(pTab) ? (pTab as Tab) : "INBOX";
  const pMin = parseFloat(params.get("min") ?? "");
  const minFilter: number | null = Number.isFinite(pMin) ? pMin : null;
  // max（ADR-0067）：分数上限，与 min 组成半开区间 [min, max)——分析页分数桶下钻的落地端。
  const pMax = parseFloat(params.get("max") ?? "");
  const maxFilter: number | null = Number.isFinite(pMax) ? pMax : null;
  // company（ADR-0067）：公司名全等筛选——分析页 Top 公司下钻的落地端。URLSearchParams
  // 已负责解码，这里不再加工（全等口径与分析页 Map 分组同源）。
  const companyFilter = params.get("company") || null;
  const pSort = params.get("sort") ?? "";
  const sortKey: SortKey = (SORT_KEYS as readonly string[]).includes(pSort) ? (pSort as SortKey) : "score";
  const sort = { key: sortKey, dir: (params.get("dir") === "1" ? 1 : -1) as 1 | -1 };

  // Search stays LOCAL for snappy typing; seeded from the URL and re-synced only
  // when the URL's q changes (i.e. the assistant set it) — never per keystroke.
  const [q, setQ] = useState(params.get("q") ?? "");
  const lastUrlQ = useRef(params.get("q") ?? "");
  useEffect(() => {
    const urlQ = params.get("q") ?? "";
    if (urlQ !== lastUrlQ.current) {
      lastUrlQ.current = urlQ;
      setQ(urlQ);
    }
  }, [params]);

  const setParams = useCallback(
    (updates: Record<string, string | number | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === "") sp.delete(k);
        else sp.set(k, String(v));
      }
      const qs = sp.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [params, router, pathname],
  );

  // Pending + deduped by CANONICAL url key (normalizeUrl) so header count, tab
  // count and triage list all agree on one number even when pipeline.md lists
  // the same posting under two raw urls (http/https twin, tracking params).
  const pendingInbox = useMemo(() => {
    const seen = new Set<string>();
    const out: InboxJob[] = [];
    for (const j of inbox) {
      const key = normalizeUrl(j.url);
      if (j.done || seen.has(key)) continue;
      seen.add(key);
      out.push(j);
    }
    return out;
  }, [inbox]);

  // Filtering/sorting live in pipeline-order.mjs — the single source of truth
  // shared with the report detail page so its prev/next navigation reproduces
  // this exact context (the list view and the detail nav must never drift).
  const filtered = useMemo(
    () => orderApplications(applications, { tab, min: minFilter, max: maxFilter, company: companyFilter ?? "", q, sortKey: sort.key, dir: sort.dir }),
    [applications, tab, minFilter, maxFilter, companyFilter, q, sort],
  );

  // The context a row link carries into the report page (and back out again):
  // tab/min/max/company/sort/dir are URL params, q is the local search state. Passing it
  // means "previous/next" and the back link return to THIS view, not the
  // default one. Built by the shared buildContextQuery so the report page's
  // prev/next/back links serialize the context IDENTICALLY. tab==="INBOX"
  // never reaches here (no tracker rows to link).
  const contextQuery = useMemo(
    () => buildContextQuery({ tab, min: minFilter, max: maxFilter, company: companyFilter ?? "", sortKey: sort.key, dir: sort.dir, q }),
    [tab, minFilter, maxFilter, companyFilter, sort.key, sort.dir, q],
  );

  // ── Batch re-evaluate ──
  // Selection is keyed by application number (r.n). Posting URLs are resolved
  // lazily from each row's report `**URL:**` header via /api/pipeline/urls the
  // moment the user checks the first box — never on a plain page visit — so
  // the default pipeline browse path stays free of report-header reads. The
  // batch fires ONE kind:"batch-evaluate" job carrying all selected http(s)
  // URLs: the backend (/api/batch-evaluate) runs the SAME engine as single
  // evaluation — the config-page CLI + model — sequentially over all URLs
  // while holding the tracker write token, instead of N separate single-evaluate agent
  // runs. When it finishes it emits co-job-done → router.refresh() picks up
  // the new scores / statuses / report bodies in one refresh.
  const { startJob } = useJobs();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [urlMap, setUrlMap] = useState<Record<string, string> | null>(null);
  const [urlMapLoading, setUrlMapLoading] = useState(false);
  const [lastBatchId, setLastBatchId] = useState<string | null>(null);
  const urlMapFetched = useRef(false);
  // Batch skip (EVALUATED tab only): marks selected rows SKIP — the canonical
  // "don't apply" state (its own 跳过 tab), same write as the report-page single
  // skip since ADR-0040.
  const [skipBusy, setSkipBusy] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  // Lazy-fetch the URL map the first time a row is checked. Reset on clear so
  // the next batch cycle refetches against the freshest reports (a finished
  // job may have written a URL the cache predates).
  useEffect(() => {
    if (selected.size === 0 || urlMapFetched.current) return;
    urlMapFetched.current = true;
    setUrlMapLoading(true);
    fetch("/api/pipeline/urls")
      .then((r) => r.json())
      .then((m) => setUrlMap(typeof m === "object" && m ? (m as Record<string, string>) : {}))
      .catch(() => setUrlMap({}))
      .finally(() => setUrlMapLoading(false));
  }, [selected.size]);

  const reevaluableCount = useMemo(
    () => (urlMap ? [...selected].filter((n) => urlMap[n]).length : 0),
    [selected, urlMap],
  );

  // 勾选与筛选是两件事：在「全部」勾、切到某个 tab 或输入搜索词后再确认，是这个持久
  // 批量条的正当用法（勾选集就是批次，筛选只是当前窗口）。所以这里不把计数收窄——收窄
  // 会把半批勾选静默丢掉——而是把「有多少勾选在屏幕外」说出来。重新评估按 URL 烧评估
  // 成本，唯一不能发生的是对看不见的行动手却不说（对照探索页批量条：那里的文案承诺
  // 「全选可加入」，故必须收窄到可见集合，见 results-view.mjs / ADR-0021）。
  const selectedOffView = useMemo(
    () => countSelectedOffView(applications, filtered, selected),
    [applications, filtered, selected],
  );

  // 「建议体检」角标（ADR-0041 决议 2）：已评估 tab 激活时懒加载一次（同
  // /api/pipeline/urls 的纪律 —— 普通浏览不做报告头读取），co-job-done 后重拉。
  // 纯提示，不参与勾选或任何自动决策。
  const [suggests, setSuggests] = useState<Set<string> | null>(null);
  const fetchSuggests = useCallback(() => {
    fetch("/api/pipeline/checkup-suggest")
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => setSuggests(m && typeof m === "object" ? new Set(Object.keys(m as Record<string, true>)) : new Set()))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (tab === "EVALUATED") fetchSuggests();
  }, [tab, fetchSuggests]);

  // Header checkbox checked / indeterminate state tracks the VISIBLE (filtered)
  // rows, not all applications — so "select all" means "all on this tab".
  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    const checkedCount = filtered.filter((r) => selected.has(r.n)).length;
    el.checked = filtered.length > 0 && checkedCount === filtered.length;
    el.indeterminate = checkedCount > 0 && checkedCount < filtered.length;
  }, [filtered, selected]);

  // Refresh the server snapshot whenever the batch evaluate finishes — the
  // evaluator wrote real tracker rows / reports the page doesn't yet see.
  useEffect(() => {
    if (!lastBatchId) return;
    const onDone = (e: Event) => {
      const detail = (e as CustomEvent).detail as { kind?: string } | undefined;
      if (detail?.kind === "evaluate" || detail?.kind === "batch-evaluate" || detail?.kind === "batch-checkup") {
        router.refresh();
        fetchSuggests(); // 体检写入后「建议体检」集合会变（新记录的行不再建议）
      }
    };
    window.addEventListener("co-job-done", onDone);
    return () => window.removeEventListener("co-job-done", onDone);
  }, [lastBatchId, router, fetchSuggests]);

  const reevaluateSelected = useCallback(() => {
    if (selected.size === 0 || !urlMap || urlMapLoading) return;
    const targets = [...selected].filter((n) => urlMap[n]);
    if (targets.length === 0) return;
    const batchId = `batch-${Date.now()}`;
    setLastBatchId(batchId);
    startJob({
      title: t("pipeline.batchReevaluate", { count: targets.length }),
      subtitle: t("pipeline.reevaluateSubtitle"),
      kind: "batch-evaluate",
      input: targets.map((n) => urlMap[n]).join("\n"),
      urls: targets.map((n) => urlMap[n]),
      page: "/pipeline",
      batchId,
    });
    // Clear selection + reset URL cache so the next cycle refetches fresh.
    setSelected(new Set());
    setUrlMap(null);
    urlMapFetched.current = false;
  }, [selected, urlMap, urlMapLoading, startJob, t]);

  // Batch checkup (EVALUATED tab only, ADR-0041): fire ONE kind:"batch-checkup"
  // job carrying every selected row number. The backend resolves each row's
  // checkup target (company / Via) at dispatch and unresolvable rows come back
  // as failed items — the client does no eligibility filtering of its own, so
  // the batch bar's count never lies about what was sent. Selection clears on
  // launch like batch re-evaluate (the card on /jobs carries the progress).
  const CHECKUP_BATCH_MAX = 20; // same per-batch cap as /api/batch-evaluate
  const checkupSelected = useCallback(() => {
    if (selected.size === 0 || selected.size > CHECKUP_BATCH_MAX) return;
    const targets = [...selected];
    const batchId = `batch-checkup-${Date.now()}`;
    setLastBatchId(batchId);
    startJob({
      title: t("pipeline.batchCheckup", { count: targets.length }),
      kind: "batch-checkup",
      input: targets.join(","),
      ns: targets,
      page: "/pipeline",
      batchId,
    });
    setSelected(new Set());
  }, [selected, startJob, t]);

  // Row click toggles selection (the blank area outside the checkbox). Links and
  // the checkbox cell stop propagation so navigation / checkbox toggle are not
  // hijacked by the row click.
  //
  // 整行用默认箭头，不挂 cursor-pointer：点行 = 勾选而非跳转，而手型按团队规范只代表
  // 链接/导航（ADR-0062 增补），否则又回到「点哪都跳」的错觉。行内的原生 checkbox 与
  // 公司名真链接各自保留手型，不在本规则约束内。可勾选线索靠 hover 底色，不靠光标。
  const toggleRow = useCallback((n: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }, []);

  // Batch skip: write SKIP for every selected row — the canonical "don't apply"
  // state (its own 跳过 tab). Only offered on the EVALUATED tab, so every target
  // is currently Evaluated → a legal forward terminal transition. Sequential
  // POSTs (not concurrent) so they don't fight over the tracker lock (503); a
  // confirm guards the blast radius of a terminal, non-undoable bulk write.
  const skipSelected = useCallback(async () => {
    if (selected.size === 0 || skipBusy) return;
    const targets = [...selected];
    if (!window.confirm(t("pipeline.batchSkipConfirm", { count: targets.length }))) return;
    setSkipBusy(true);
    try {
      for (const n of targets) {
        await fetch("/api/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ n, status: "SKIP" }),
        });
      }
      router.refresh();
      setSelected(new Set());
    } finally {
      setSkipBusy(false);
    }
  }, [selected, skipBusy, router, t]);

  return (
    /* 内容区宽度自适应（ADR-0065）：外层不设 mx-auto/max-w，铺满左侧栏右侧的全部可用宽度
       （原 ADR-0011 语境里的 mx-auto max-w-6xl 已退役）；定高/滚动布局仍按 ADR-0011。 */
    <div className="px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24 md:flex md:h-screen md:flex-col">
      <div className="flex items-end justify-between gap-4 md:shrink-0">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">{t("pipeline.title")}</h1>
          <p className="mt-1 text-sm text-muted">
            {t("pipeline.inboxSummary", { count: pendingInbox.length, total: applications.length })}
          </p>
        </div>
        {/* the tracker has its own search; the inbox brings its own facet filters */}
        {tab !== "INBOX" && (
          <div className="relative w-64 max-w-[40vw]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("pipeline.searchPlaceholder")}
              className="w-full rounded-md border border-border bg-surface/60 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
            />
          </div>
        )}
      </div>

      {/* tabs */}
      <div className="mt-6 flex flex-wrap gap-1 border-b border-border md:shrink-0">
        {TABS.map((tabKey) => {
          const count =
            tabKey === "INBOX"
              ? pendingInbox.length
              : tabKey === "ALL"
                ? applications.length
                : applications.filter((r) => canonStatus(r.status).includes(tabKey)).length;
          return (
            <button
              key={tabKey}
              onClick={() => setParams({ tab: tabKey === "INBOX" ? null : tabKey })}
              className={cn(
                "-mb-px inline-flex items-center justify-center border-b-2 px-3 py-2 text-xs font-medium transition-colors max-sm:min-h-[44px]",
                tab === tabKey
                  ? "border-brand text-foreground"
                  : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {TAB_LABELS[tabKey]} <span className="text-faint tabular-nums">{count}</span>
            </button>
          );
        })}
        {/* 分数筛选 chip 住进 tabs 行（ADR-0039 决议 5）：它原先是 tabs 下面的独立一行，
            点 X 清除时整行消失会把列表上跳——同一类位移。tabs 行本就常驻，chip 的挂载/
            卸载不再改变列表高度。窄屏下它仍可能让 tabs 行多/少折一行：已知残差。 */}
        {tab !== "INBOX" && (minFilter != null || maxFilter != null || companyFilter != null) && (
          <div className="ml-auto flex items-center gap-2 pl-2">
            <span className="text-xs text-faint">{t("pipeline.filtered")}</span>
            <button
              type="button"
              onClick={() => setParams({ min: null, max: null })}
              className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand transition-colors hover:bg-brand/15"
              title={t("pipeline.clearScoreFilter")}
            >
              {/* 分数是一个维度、一枚 chip（ADR-0067 决议 5）：有 max 时单枚显示完整
                  区间，清除上下限一起清；无 max 时维持现状「分数 ≥ x」只清 min。 */}
              {maxFilter != null
                ? minFilter != null
                  ? t("pipeline.scoreRange", { min: minFilter.toFixed(1), max: maxFilter.toFixed(1) })
                  : t("pipeline.scoreLt", { max: maxFilter.toFixed(1) })
                : t("pipeline.scoreGte", { min: minFilter!.toFixed(1) })}
              <X className="size-3" />
            </button>
            {/* 公司 chip（ADR-0067 决议 5）：独立一枚，与分数 chip、搜索框 AND 叠加。 */}
            {companyFilter != null && (
              <button
                type="button"
                onClick={() => setParams({ company: null })}
                className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand transition-colors hover:bg-brand/15"
                title={t("pipeline.clearCompanyFilter")}
              >
                <span className="truncate">{t("pipeline.companyIs", { company: companyFilter })}</span>
                <X className="size-3 shrink-0" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* 批量条的常驻槽位（ADR-0039 决议 1/2/3）：非 INBOX tab 恒在，只切内容——条的出现/
          消失不再把表格容器顶开，勾选时列表不再下滑。`md:` 以下没有定高布局，槽位不存在
          （条出现时照旧下推列表：已知残差）。空态那一句提示语由 RowSlot 渲染，按 tab 对齐
          动作（已评估 tab 才有批量跳过，ADR-0038 决议 2）。 */}
      {tab !== "INBOX" && (
        <RowSlot hint={tab === "EVALUATED" ? t("pipeline.batchHintEvaluated") : t("pipeline.batchHint")}>
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-full border border-brand/30 bg-brand-soft/40 px-3 py-1.5 text-xs max-md:mt-3 md:flex-nowrap">
              <span className="shrink-0 font-medium text-brand">{t("pipeline.batchSelected", { count: selected.size })}</span>
              {selectedOffView > 0 && (
                <span className="min-w-0 truncate text-muted">{t("pipeline.batchOffView", { count: selectedOffView })}</span>
              )}
              {urlMapLoading ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-muted">
                  <Loader2 className="size-3 animate-spin" /> {t("pipeline.batchUrlsLoading")}
                </span>
              ) : urlMap ? (
                <span className="min-w-0 truncate text-muted">
                  {reevaluableCount === 0
                    ? t("pipeline.batchNoneHasUrl")
                    : t("pipeline.batchReevaluableHint", { count: reevaluableCount, total: selected.size })}
                </span>
              ) : null}
              <button
                type="button"
                onClick={reevaluateSelected}
                disabled={reevaluableCount === 0 || urlMapLoading || urlMap === null}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand px-3 py-1 font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]"
                title={t("pipeline.batchReevaluateTitle", { count: reevaluableCount })}
              >
                <RotateCcw className="size-3.5" /> {t("pipeline.batchReevaluate", { count: reevaluableCount })}
              </button>
              {tab === "EVALUATED" && (
                <>
                  <button
                    type="button"
                    onClick={checkupSelected}
                    disabled={selected.size > CHECKUP_BATCH_MAX}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1 font-medium text-muted transition-colors hover:border-brand/50 hover:text-brand disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]"
                    title={t(selected.size > CHECKUP_BATCH_MAX ? "pipeline.batchCheckupTooMany" : "pipeline.batchCheckupTitle", { count: selected.size, max: CHECKUP_BATCH_MAX })}
                  >
                    <HeartPulse className="size-3.5" /> {t("pipeline.batchCheckup", { count: selected.size })}
                  </button>
                  <button
                    type="button"
                    onClick={skipSelected}
                    disabled={skipBusy}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1 font-medium text-muted transition-colors hover:border-red-400/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]"
                    title={t("pipeline.batchSkipTitle", { count: selected.size })}
                  >
                    {skipBusy ? <Loader2 className="size-3.5 animate-spin" /> : <SkipForward className="size-3.5" />} {t("pipeline.batchSkip", { count: selected.size })}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1 text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]"
              >
                <X className="size-3" /> {t("pipeline.batchClear")}
              </button>
            </div>
          )}
        </RowSlot>
      )}

      {tab === "INBOX" ? (
        /* ── Inbox: the triage surface (Abundance → Triage → Shortlist → Score) ── */
        pendingInbox.length > 0 ? (
          <InboxTriage inbox={pendingInbox} scoredUrls={scoredUrls} />
        ) : (
          <InboxEmpty count={0} filtered={false} />
        )
      ) : filtered.length > 0 ? (
        /* ── Tracker table ──
           overflow-x-auto, not overflow-hidden: the rounded corners still clip,
           but a table too wide for the viewport can now be scrolled to instead
           of being silently cut off. min-w keeps the columns readable rather
           than letting w-full crush them on a phone.
           44rem 是薪资/用时/体检三列加入前的旧值（ADR-0064 决议 11）：10 列下
           被挤压的总是公司/职位两列——窄窗口靠横向滚动，不靠换行撑高行。 */
        <div className="mt-4 overflow-x-auto rounded-2xl border border-border md:min-h-0 md:flex-1 md:overflow-y-auto">
          <table className="w-full min-w-[60rem] text-sm">
            <thead className="sticky top-0 z-10 border-b border-border bg-surface text-left text-xs uppercase tracking-wide text-faint">
              <tr>
                <th className="w-10 px-2 py-2.5">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    aria-label={t("pipeline.batchSelectAll")}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) filtered.forEach((r) => next.add(r.n));
                      else filtered.forEach((r) => next.delete(r.n));
                      setSelected(next);
                    }}
                    className="size-4 cursor-pointer rounded border-border text-brand accent-brand align-middle"
                  />
                </th>
                {SORT_KEYS.map((k) => (
                  <th
                    key={k}
                    className="cursor-pointer select-none whitespace-nowrap px-4 py-2.5 font-medium hover:text-foreground"
                    onClick={() => setParams({ sort: k, dir: sort.key === k ? sort.dir * -1 : -1 })}
                  >
                    <span className="inline-flex items-center gap-1">
                      {SORT_LABELS[k]}
                      <ChevronsUpDown className="size-3" />
                    </span>
                  </th>
                ))}
                {/* 来源列：纯展示，不参与排序，置于日期列后 */}
                <th className="whitespace-nowrap px-4 py-2.5 font-medium">{t("pipeline.col.source")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r, i) => (
                <tr
                  key={`${r.n}-${i}`}
                  onClick={() => toggleRow(r.n)}
                  className="group transition-colors hover:bg-surface/40"
                >
                  <td className="w-10 px-2 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.n)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(r.n);
                        else next.delete(r.n);
                        setSelected(next);
                      }}
                      className="size-4 cursor-pointer rounded border-border text-brand accent-brand align-middle"
                      aria-label={companyLabel(r)}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {/* ADR-0062：公司名是全行唯一的站内导航入口。职位与分数曾经也
                        是链接，用户想勾选行做批量却误点跳页、丢列表筛选与滚动位置。
                        ADR-0064 修订：格内只剩 logo + 名称——体检★/建议 chip 全部搬进
                        体检列（双星重复且占宽是公司名换行的主因）；超长单行截断，
                        全名进悬停 title，行高恒定。ADR-0065：内容区放开后上限
                        16rem → 24rem——列宽了截断点必须跟走，否则列内死白。 */}
                    <div className="flex max-w-[24rem] items-center">
                      <Link
                        href={`/pipeline/${r.n}${contextQuery}`}
                        onClick={(e) => e.stopPropagation()}
                        title={companyLabel(r)}
                        className="inline-flex min-w-0 max-w-full items-center gap-2.5 transition-colors group-hover:text-brand"
                      >
                        <CompanyLogo name={companyLabel(r)} size={20} />
                        <span className="truncate">{companyLabel(r)}</span>
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {/* 职位常带括号后缀（方向/城市），同样单行截断 + 全文悬停（ADR-0064 决议 11）；
                        ADR-0065：内容区放开后上限 22rem → 32rem。 */}
                    <div className="max-w-[32rem] truncate" title={r.role}>{r.role}</div>
                  </td>
                  <td className="px-4 py-3">
                    {/* 分数只做展示（ADR-0062）：曾经的 /report/{n} 直跳通道让位于
                        「误点不跳页」；该路由仍服务扩展深链与工作器 #N（ADR-0018）。 */}
                    <Badge tone={scoreTone(r.score)}>{r.score || "—"}</Badge>
                  </td>
                  {/* 报告薪资（ADR-0037）：归一化月薪区间，报告的字段原文进悬停提示；
                      未披露/无报告 → 「—」（与分数列、来源列的空值写法一致，全列只有
                      「区间」与「—」两种形态）。 */}
                  <td
                    className={cn(
                      "whitespace-nowrap px-4 py-3 tabular-nums",
                      r.reportSalary?.range ? "text-muted" : "text-faint",
                    )}
                    title={r.reportSalary?.text || undefined}
                  >
                    {r.reportSalary?.range ? formatSalaryRange(r.reportSalary.range) : "—"}
                  </td>
                  {/* 体检列三态（ADR-0064 修订决议 5）：有记录 → ★；无记录但命中
                      建议 → chip（只随已评估 tab 的懒加载边界渲染——suggests 集合离开
                      该 tab 后仍残留，渲染处必须判 tab）；皆无 → 空格，空格不是「★0」，
                      与恒沉底的排序口径同一个诚实姿态。公司格不再持任何体检信息。 */}
                  {(() => {
                    const c = checkups?.[r.n];
                    if (c) {
                      return (
                        <td className="whitespace-nowrap px-4 py-3 tabular-nums" title={checkupTitle(r.n) || undefined}>
                          <Badge tone={checkupTone(c.star)}>★{c.star.toFixed(1)}</Badge>
                        </td>
                      );
                    }
                    if (tab === "EVALUATED" && suggests?.has(r.n)) {
                      return (
                        <td className="whitespace-nowrap px-4 py-3" title={t("pipeline.suggestCheckupTitle")}>
                          <Badge tone="warn">{t("pipeline.suggestCheckup")}</Badge>
                        </td>
                      );
                    }
                    return <td className="whitespace-nowrap px-4 py-3" />;
                  })()}
                  <td className="whitespace-nowrap px-4 py-3 text-muted tabular-nums">
                    {fmtDuration(r.evalDuration ?? null)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(r.status))} />
                      {statusLabel(r.status)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-faint tabular-nums">
                    {r.date}
                    {r.revalDate && r.revalDate !== r.date && (
                      <span className="block text-[11px] leading-4 text-faint/70">
                        {t("pipeline.revalOn", { date: r.revalDate })}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-faint">{sourceLabel(r.url) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
          <p className="font-display text-lg">{t("pipeline.noMatches")}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{t("pipeline.noMatchesHint")}</p>
        </div>
      )}
    </div>
  );
}

// Empty inbox. Self-sufficient for the mainstream user (a primary in-web action),
// honest for devs (the CLI/file path stays, demoted to progressive transparency).
function InboxEmpty({ count, filtered }: { count: number; filtered: boolean }) {
  const { t } = useI18n();
  if (filtered) {
    return (
      <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
        <p className="font-display text-lg">{t("pipeline.noMatches")}</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{t("pipeline.clearSearchInbox")}</p>
      </div>
    );
  }
  return (
    <div className="dot-bg mt-4 overflow-hidden rounded-2xl border border-border bg-surface/50 bg-origin-border bg-gradient-to-tr from-brand/10 via-transparent to-transparent shadow-lg">
      <div className="flex items-center gap-2 border-b border-foreground/10 px-5 py-3">
        <span className="size-2.5 rounded-full bg-foreground/15" aria-hidden="true" />
        <span className="size-2.5 rounded-full bg-foreground/15" aria-hidden="true" />
        <span className="size-2.5 rounded-full bg-foreground/15" aria-hidden="true" />
        <span className="ml-3 font-mono text-xs tracking-wide text-muted">{t("pipeline.inboxHeader")}</span>
      </div>
      <div className="px-6 py-10 text-center">
        <p className="font-display text-lg">
          {t("pipeline.inboxEmpty")}
        </p>
        {count > 0 ? (
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">{t("pipeline.inboxEmptyPending")}</p>
        ) : (
          <>
            <p className="mx-auto mt-2 max-w-sm text-sm text-muted">{t("pipeline.inboxEmptyFind")}</p>
            <Link
              href="/explore?run=1"
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground shadow-sm transition-all duration-200 hover:bg-brand-200 hover:-translate-y-0.5 hover:shadow-md"
            >
              <Compass className="size-4" /> {t("pipeline.runFirstScan")} <ArrowRight className="size-4" />
            </Link>
            <p className="mx-auto mt-4 max-w-sm text-xs text-muted">
              {t("pipeline.inboxEmptyTerminal")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
