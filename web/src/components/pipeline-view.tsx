"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, ChevronsUpDown, X, Compass, ArrowRight, RotateCcw, Loader2 } from "lucide-react";
import type { Application, InboxJob } from "@/lib/career-ops";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { canonStatus, scoreTone, statusDot } from "@/lib/format";
import { orderApplications, buildContextQuery } from "@/lib/pipeline-order.mjs";
import { InboxTriage } from "@/components/inbox/inbox-triage";
import { useJobs } from "@/components/jobs/job-store";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

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

const SORT_KEYS = ["company", "role", "score", "status", "date"] as const;
type SortKey = (typeof SORT_KEYS)[number];

export function PipelineView({
  applications,
  inbox,
}: {
  applications: Application[];
  inbox: InboxJob[];
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();

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
    status: t("pipeline.col.status"),
    date: t("pipeline.col.date"),
  };
  const statusLabel = (s: string) => {
    const key = `pipeline.status.${s.toLowerCase()}`;
    const v = t(key);
    return v === key ? s : v;
  };

  // The URL is the SINGLE source of truth for tab/min/sort/dir, so the home stat
  // tiles' deep links AND the assistant's filterPipeline/navigate actions drive
  // the table identically (no useState mirror → no desync).
  const pTab = (params.get("tab") ?? "").toUpperCase();
  const tab: Tab = (TABS as readonly string[]).includes(pTab) ? (pTab as Tab) : "INBOX";
  const pMin = parseFloat(params.get("min") ?? "");
  const minFilter: number | null = Number.isFinite(pMin) ? pMin : null;
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

  // Pending + deduped by URL (pipeline.md can list the same posting twice) so the
  // header count, the tab count and the triage list all agree on one number.
  const pendingInbox = useMemo(() => {
    const seen = new Set<string>();
    const out: InboxJob[] = [];
    for (const j of inbox) {
      if (j.done || seen.has(j.url)) continue;
      seen.add(j.url);
      out.push(j);
    }
    return out;
  }, [inbox]);

  // Filtering/sorting live in pipeline-order.mjs — the single source of truth
  // shared with the report detail page so its prev/next navigation reproduces
  // this exact context (the list view and the detail nav must never drift).
  const filtered = useMemo(
    () => orderApplications(applications, { tab, min: minFilter, q, sortKey: sort.key, dir: sort.dir }),
    [applications, tab, minFilter, q, sort],
  );

  // The context a row link carries into the report page (and back out again):
  // tab/min/sort/dir are URL params, q is the local search state. Passing it
  // means "previous/next" and the back link return to THIS view, not the
  // default one. Built by the shared buildContextQuery so the report page's
  // prev/next/back links serialize the context IDENTICALLY. tab==="INBOX"
  // never reaches here (no tracker rows to link).
  const contextQuery = useMemo(
    () => buildContextQuery({ tab, min: minFilter, sortKey: sort.key, dir: sort.dir, q }),
    [tab, minFilter, sort.key, sort.dir, q],
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
      if (detail?.kind === "evaluate" || detail?.kind === "batch-evaluate") router.refresh();
    };
    window.addEventListener("co-job-done", onDone);
    return () => window.removeEventListener("co-job-done", onDone);
  }, [lastBatchId, router]);

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

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24">
      <div className="flex items-end justify-between gap-4">
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
      <div className="mt-6 flex flex-wrap gap-1 border-b border-border">
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
      </div>

      {tab !== "INBOX" && minFilter != null && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-faint">{t("pipeline.filtered")}</span>
          <button
            type="button"
            onClick={() => setParams({ min: null })}
            className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand transition-colors hover:bg-brand/15"
            title={t("pipeline.clearScoreFilter")}
          >
            {t("pipeline.scoreGte", { min: minFilter.toFixed(1) })}
            <X className="size-3" />
          </button>
        </div>
      )}

      {tab !== "INBOX" && selected.size > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-full border border-brand/30 bg-brand-soft/40 px-3 py-1.5 text-xs">
          <span className="font-medium text-brand">{t("pipeline.batchSelected", { count: selected.size })}</span>
          {urlMapLoading ? (
            <span className="inline-flex items-center gap-1 text-muted">
              <Loader2 className="size-3 animate-spin" /> {t("pipeline.batchUrlsLoading")}
            </span>
          ) : urlMap ? (
            <span className="text-muted">
              {reevaluableCount === 0
                ? t("pipeline.batchNoneHasUrl")
                : t("pipeline.batchReevaluableHint", { count: reevaluableCount, total: selected.size })}
            </span>
          ) : null}
          <button
            type="button"
            onClick={reevaluateSelected}
            disabled={reevaluableCount === 0 || urlMapLoading || urlMap === null}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1 font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-[44px]"
            title={t("pipeline.batchReevaluateTitle", { count: reevaluableCount })}
          >
            <RotateCcw className="size-3.5" /> {t("pipeline.batchReevaluate", { count: reevaluableCount })}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]"
          >
            <X className="size-3" /> {t("pipeline.batchClear")}
          </button>
        </div>
      )}

      {tab === "INBOX" ? (
        /* ── Inbox: the triage surface (Abundance → Triage → Shortlist → Score) ── */
        pendingInbox.length > 0 ? (
          <InboxTriage inbox={pendingInbox} />
        ) : (
          <InboxEmpty count={0} filtered={false} />
        )
      ) : filtered.length > 0 ? (
        /* ── Tracker table ──
           overflow-x-auto, not overflow-hidden: the rounded corners still clip,
           but a table too wide for the viewport can now be scrolled to instead
           of being silently cut off. min-w keeps the columns readable rather
           than letting w-full crush them on a phone. */
        <div className="mt-4 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
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
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r, i) => (
                <tr key={`${r.n}-${i}`} className="group transition-colors hover:bg-surface/40">
                  <td className="w-10 px-2 py-3">
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
                      aria-label={r.company}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/pipeline/${r.n}${contextQuery}`} className="flex items-center gap-2.5 transition-colors group-hover:text-brand">
                      <CompanyLogo name={r.company} size={20} />
                      {r.company}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <Link href={`/pipeline/${r.n}${contextQuery}`}>{r.role}</Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={scoreTone(r.score)}>{r.score || "—"}</Badge>
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
