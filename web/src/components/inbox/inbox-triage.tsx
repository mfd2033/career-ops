"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import type { InboxJob } from "@/lib/career-ops";
import type { AtsSource } from "@/lib/explore";
import { ATS_SOURCES } from "@/lib/explore";
import { daysSince, seniorityFromTitle, sourceFromUrl, SENIORITY_ORDER, type Seniority } from "@/lib/inbox";
import { normalizeUrl } from "@/lib/core/url-key.mjs";
import { inboxSalaryRange, inboxSalaryMedian, passesInboxSalaryFloor } from "@/lib/inbox-salary.mjs";
import { resolveRowScore } from "@/lib/inbox-score.mjs";
import { scoreTone } from "@/lib/format";
import { scoreNum } from "@/lib/score-num.mjs";
import { FacetChips } from "./facet-chips";
import { TriageRow, type RowScore } from "./triage-row";
import { ShortlistTray, type ShortItem } from "./shortlist-tray";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

const SHORTLIST_KEY = "career-ops:shortlist";
const HIDDEN_KEY = "career-ops:hidden";
const CONFIG_KEY = "career-ops:config";
// 收件箱薪资 facet 的持久化（ADR-0023 决定 3）：跟随 shortlist/hidden 的
// localStorage 惯例（ADR-0010），刷新/重开保持。
const SALARY_FLOOR_KEY = "career-ops:inbox-salary-min";
const SALARY_SORT_KEY = "career-ops:inbox-salary-sort";
// 未评分 facet 的持久化（ADR-0024）：与薪资排序同 localStorage 惯例。
// 无记录 → 默认开；用户手动关掉后每次加载保持关。
const UNSCORED_KEY = "career-ops:inbox-unscored";
const BATCH = 20;
// /api/batch-evaluate's own MAX_URLS. A longer shortlist is sent as chunks.
const SCORE_BATCH_MAX = 20;

// The inbox as a TRIAGE surface: Abundance → Triage → Shortlist → Opt-in Score.
// Default (ADR-0024): 未评分过滤 + 按薪资排序默认激活（均持久化于 localStorage，无记录
// 时用默认开）→ anyFacet 恒真，默认是全量未评分墙，fresh-batch 截断不再是默认（仅在
// 用户关掉两个开关后出现）。Free facets + Save/Skip narrow it; only "Score
// shortlist" spends tokens. 🔴 The shell is agnostic to what makes a role
// relevant — order is the single documented plug point below.
//
// scoredUrls: durable URL → tracker score map (server-built from reports'
// `**URL:**` headers). The live job-store only covers evaluations fired THIS
// browser — postings already evaluated via CLI / batch / an earlier session
// must still show their real score, not a false "not scored".
export function InboxTriage({ inbox, scoredUrls }: { inbox: InboxJob[]; scoredUrls?: Record<string, { score: string }> }) {
  const { jobs, startJob } = useJobs();
  const { t } = useI18n();
  const router = useRouter();

  // facets
  const [within, setWithin] = useState<number | null>(null);
  const [sources, setSources] = useState<Set<AtsSource>>(() => new Set());
  const [seniorities, setSeniorities] = useState<Set<Seniority>>(() => new Set());
  const [locQ, setLocQ] = useState("");
  const [kw, setKw] = useState("");
  // 默认开（ADR-0024）；持久化键见上——无记录保持默认，显式 "0" 关
  const [unscoredOnly, setUnscoredOnly] = useState(true);
  // 薪资下限（月薪 K）——与探索页同一语义（区间重叠、未知放行打标）
  const [salaryMin, setSalaryMin] = useState<number | null>(null);
  // 按薪资排序（ADR-0023 决定 4；默认开见 ADR-0024）：开 = 解析区间中位值降序、未知沉底；关 = 新鲜度
  const [sortBySalary, setSortBySalary] = useState(true);
  const [showAll, setShowAll] = useState(false);

  // persisted triage state + ephemeral selection/undo
  const [shortlist, setShortlist] = useState<ShortItem[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [undo, setUndo] = useState<{ label: string; fn: () => void } | null>(null);
  const [hasCli, setHasCli] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Set when the shortlist is dispatched; arms the post-batch server refresh.
  const [scoredBatchId, setScoredBatchId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const s = localStorage.getItem(SHORTLIST_KEY);
      if (s) setShortlist(JSON.parse(s));
      const h = localStorage.getItem(HIDDEN_KEY);
      if (h) setHidden(JSON.parse(h));
      const c = localStorage.getItem(CONFIG_KEY);
      setHasCli(!!(c && JSON.parse(c).cliId));
      const f = localStorage.getItem(SALARY_FLOOR_KEY);
      if (f) {
        const n = Number(f);
        if (Number.isFinite(n) && n > 0) setSalaryMin(n);
      }
      // 两者默认开（ADR-0024）：无记录 → 保持默认开；显式 "0" → 关
      setSortBySalary(localStorage.getItem(SALARY_SORT_KEY) !== "0");
      const u = localStorage.getItem(UNSCORED_KEY);
      if (u != null) setUnscoredOnly(u === "1");
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) try { localStorage.setItem(SHORTLIST_KEY, JSON.stringify(shortlist)); } catch { /* quota */ }
  }, [shortlist, loaded]);
  useEffect(() => {
    if (loaded) try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)); } catch { /* quota */ }
  }, [hidden, loaded]);
  useEffect(() => {
    if (loaded) try { localStorage.setItem(SALARY_FLOOR_KEY, salaryMin != null ? String(salaryMin) : ""); } catch { /* quota */ }
  }, [salaryMin, loaded]);
  useEffect(() => {
    if (loaded) try { localStorage.setItem(SALARY_SORT_KEY, sortBySalary ? "1" : "0"); } catch { /* quota */ }
  }, [sortBySalary, loaded]);
  useEffect(() => {
    if (loaded) try { localStorage.setItem(UNSCORED_KEY, unscoredOnly ? "1" : "0"); } catch { /* quota */ }
  }, [unscoredOnly, loaded]);
  // auto-dismiss the undo toast
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 5000);
    return () => clearTimeout(t);
  }, [undo]);
  // After a scoring batch finishes, re-read the server snapshot: the batch
  // merged the tracker rows AND moved those postings out of data/pipeline.md,
  // so both the score map and the row set have changed. Mirrors the tracker's
  // batch re-evaluate refresh (pipeline-view.tsx) — without it the rows would
  // sit there looking unscored until a manual reload.
  useEffect(() => {
    if (!scoredBatchId) return;
    const onDone = (e: Event) => {
      const detail = (e as CustomEvent).detail as { kind?: string } | undefined;
      if (detail?.kind === "batch-evaluate") router.refresh();
    };
    window.addEventListener("co-job-done", onDone);
    return () => window.removeEventListener("co-job-done", onDone);
  }, [scoredBatchId, router]);

  // stable "now" for freshness (per mount)
  const now = useMemo(() => Date.now(), []);

  // Dedupe by CANONICAL key (normalizeUrl) — the same posting triaged under two
  // raw URLs that differ only in scheme/click-or-tracking params (e.g. an
  // `http://www.zhaopin.com/...` row and its `https://...` twin, or a BOSS/猎聘
  // URL with per-request securityId/ka) is ONE job, so it triages once. This is
  // the SAME identity the score lookups use, so a dedupe'd card's score badge,
  // Save and Skip all key uniformly instead of scattering per raw URL.
  const enriched = useMemo(() => {
    const seen = new Set<string>();
    const out: { job: InboxJob; source: AtsSource | null; seniority: Seniority | null; age: number | null; urlKey: string; salaryRange: ReturnType<typeof inboxSalaryRange> }[] = [];
    for (const job of inbox) {
      const urlKey = normalizeUrl(job.url);
      if (seen.has(urlKey)) continue;
      seen.add(urlKey);
      out.push({
        job,
        source: sourceFromUrl(job.url),
        seniority: seniorityFromTitle(job.role),
        age: daysSince(job.postedAt, now),
        urlKey,
        // 过滤/排序共用的月薪区间（薪资未知 → null，与 job.salaryUnknown 同源）
        salaryRange: inboxSalaryRange(job.salaryText, job.url),
      });
    }
    return out;
  }, [inbox, now]);

  // EVALUADA lookup part 1 — LIVE: the latest evaluate worker per posting URL
  // keyed by the SAME normalizeUrl(...) the persisted map uses, so both sides
  // compare canonically (running → badge). Covers only this browser's sessions.
  const liveScores = useMemo(() => {
    const best = new Map<string, (typeof jobs)[number]>();
    for (const j of jobs) {
      if (!j.input || j.kind !== "evaluate") continue;
      const key = normalizeUrl(j.input);
      const ex = best.get(key);
      if (!ex || j.startedAt > ex.startedAt) best.set(key, j);
    }
    const m = new Map<string, RowScore>();
    for (const [key, j] of best) {
      m.set(key, { score: j.result?.score ?? null, tone: j.result?.tone ?? "muted", jobId: j.id, running: j.status === "running" });
    }
    return m;
  }, [jobs]);

  // EVALUADA lookup part 2 — PERSISTED: durable tracker scores for postings
  // evaluated outside this browser (CLI pipeline, batch, prior sessions). No
  // job to link to → jobId "" (TriageRow renders a bare badge).
  const persistedScores = useMemo(() => {
    const m = new Map<string, RowScore>();
    for (const [key, s] of Object.entries(scoredUrls ?? {})) {
      const n = scoreNum(s.score);
      m.set(key, { score: Number.isNaN(n) ? null : n, tone: scoreTone(s.score), jobId: "", running: false });
    }
    return m;
  }, [scoredUrls]);

  // facet options — only surface what's actually present in the (non-hidden) data
  const availSources = useMemo(() => {
    const set = new Set<AtsSource>();
    for (const e of enriched) if (e.source && !hidden.includes(e.urlKey)) set.add(e.source);
    return ATS_SOURCES.filter((s) => set.has(s));
  }, [enriched, hidden]);
  const availSeniorities = useMemo(() => {
    const set = new Set<Seniority>();
    for (const e of enriched) if (e.seniority && !hidden.includes(e.urlKey)) set.add(e.seniority);
    return SENIORITY_ORDER.filter((s) => set.has(s));
  }, [enriched, hidden]);

  // A row counts as "evaluated" when an effective score exists (live verdict, live
  // spinner, or a persisted tracker score). Used by the unchecked-only filter; mirrors
  // the row's own evaluated flag in TriageRow so the two can never disagree.
  const isEvaluatedRow = (s: RowScore | undefined) => !!s && (s.running || s.score != null);

  const filtered = useMemo(
    () =>
      enriched.filter((e) => {
        if (hidden.includes(e.urlKey)) return false;
        if (within != null && (e.age == null || e.age > within)) return false;
        if (sources.size && (!e.source || !sources.has(e.source))) return false;
        if (seniorities.size && (!e.seniority || !seniorities.has(e.seniority))) return false;
        if (locQ.trim() && !(e.job.location || "").toLowerCase().includes(locQ.trim().toLowerCase())) return false;
        if (kw.trim() && !`${e.job.company} ${e.job.role}`.toLowerCase().includes(kw.trim().toLowerCase())) return false;
        // 薪资下限：区间重叠保留、未知放行（与探索页同语义，ADR-0023）
        if (!passesInboxSalaryFloor(e.salaryRange, salaryMin)) return false;
        if (unscoredOnly && isEvaluatedRow(resolveRowScore(liveScores.get(e.urlKey), persistedScores.get(e.urlKey)))) return false;
        return true;
      }),
    [enriched, hidden, within, sources, seniorities, locQ, kw, salaryMin, unscoredOnly, liveScores, persistedScores],
  );

  // 🔴 SINGLE ORDER PLUG POINT — exactly one comparator, chosen by the sort toggle:
  // "按薪资" (default on, ADR-0024) = salary median descending, unknown salary
  // sinking to the bottom, ties falling back to freshness (ADR-0023/0024); off =
  // freshness (newest first_seen first; unknown last). Facets / triage /
  // shortlist / score never touch relevance. This is the whole firewall.
  const ordered = useMemo(
    () =>
      [...filtered].sort(
        sortBySalary
          ? (a, b) => {
              const ma = inboxSalaryMedian(a.salaryRange);
              const mb = inboxSalaryMedian(b.salaryRange);
              if (ma == null || mb == null) {
                // 薪资未知沉底；两边都未知时退回新鲜度，保持稳定可预期
                if (ma == null && mb == null) return (a.age ?? Infinity) - (b.age ?? Infinity);
                return ma == null ? 1 : -1;
              }
              if (ma !== mb) return mb - ma; // 中位值降序
              // 平手回退新鲜度（ADR-0024）——不依赖排序稳定性这类隐含实现细节
              return (a.age ?? Infinity) - (b.age ?? Infinity);
            }
          : (a, b) => (a.age ?? Infinity) - (b.age ?? Infinity),
      ),
    [filtered, sortBySalary],
  );

  const anyFacet = within != null || sources.size > 0 || seniorities.size > 0 || locQ.trim() !== "" || kw.trim() !== "" || salaryMin != null || unscoredOnly;
  const capped = !showAll && !anyFacet;
  const visible = capped ? ordered.slice(0, BATCH) : ordered;
  const hiddenCount = hidden.length;

  const isShortlisted = (url: string) => shortlist.some((s) => s.url === url);

  const save = (job: InboxJob) => {
    const urlKey = normalizeUrl(job.url);
    if (isShortlisted(urlKey)) return;
    setShortlist((s) => [...s, { url: urlKey, href: job.url, company: job.company, role: job.role }]);
  };
  const skip = (job: InboxJob) => {
    const urlKey = normalizeUrl(job.url);
    setHidden((h) => (h.includes(urlKey) ? h : [...h, urlKey]));
    setUndo({ label: t("inbox.skipped", { company: job.company }), fn: () => setHidden((h) => h.filter((u) => u !== urlKey)) });
  };
  const toggleSelect = (url: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });
  const saveSelected = () => {
    const add = enriched
      .filter((e) => selected.has(e.urlKey) && !isShortlisted(e.urlKey))
      .map((e) => ({ url: e.urlKey, href: e.job.url, company: e.job.company, role: e.job.role }));
    if (add.length) setShortlist((s) => [...s, ...add]);
    setSelected(new Set());
  };

  // Select-all operates on the FULL filtered set (not the capped first slice), so the
  // "只看未评分 → 全选 → 批量跳过/保存" flow covers every match in one pass. The header
  // button toggles: already-everything-selected turns it into a clear-all.
  const allFilteredSelected = filtered.length > 0 && filtered.every((e) => selected.has(e.urlKey));
  const toggleSelectAll = () => {
    if (allFilteredSelected) setSelected(new Set());
    else setSelected(new Set(filtered.map((e) => e.urlKey)));
  };
  // Batch skip hides every selected url at once; the aggregated undo restores them all.
  const skipSelected = () => {
    const urls = [...selected];
    if (!urls.length) return;
    setHidden((h) => Array.from(new Set([...h, ...urls])));
    setUndo({
      label: t("inbox.skippedN", { n: urls.length }),
      fn: () => setHidden((h) => h.filter((u) => !urls.includes(u))),
    });
    setSelected(new Set());
  };

  // Estimate from BOTH scoring kinds: batch-evaluate is what this tray now
  // dispatches, evaluate is what earlier sessions left in the job history (and
  // what a previous build dispatched) — a sample from either keeps the cost
  // disclosure populated instead of silently degrading to "uses your tokens".
  const estimate = useMemo(() => {
    const samples = jobs
      .filter((j) => (j.kind === "evaluate" || j.kind === "batch-evaluate") && j.status === "done" && j.cost?.tokens)
      .map((j) => j.cost!);
    if (!samples.length || shortlist.length === 0) return {};
    const avgT = samples.reduce((a, c) => a + c.tokens, 0) / samples.length;
    const usds = samples.filter((s) => s.usd != null).map((s) => s.usd!);
    const avgUsd = usds.length ? usds.reduce((a, c) => a + c, 0) / usds.length : undefined;
    return { tokens: Math.round(avgT * shortlist.length), usd: avgUsd != null ? +(avgUsd * shortlist.length).toFixed(2) : undefined };
  }, [jobs, shortlist.length]);

  // Scoring goes through /api/batch-evaluate — the SAME path the tracker's
  // "re-evaluate selected" uses — instead of N single `evaluate` jobs. The
  // single-evaluate path is the one that never marked the posting done: it wrote
  // a tracker row but left the `- [ ]` row in data/pipeline.md, so triaging the
  // inbox never actually shrank it (the file only grew; 9161 pending rows for
  // 2500 real postings on 2026-09-14). Batch evaluate folds the tracker AND runs
  // reconcile-pipeline.mjs --entry, the completion marker the house rules
  // require of anything readInbox() displays; it also runs one bounded pool
  // under one tracker-write token instead of N agents racing the same files.
  const scoreShortlist = () => {
    const urls = shortlist.map((it) => it.url);
    if (urls.length === 0) return;
    const batchId = `shortlist-${Date.now()}`;
    for (let i = 0; i < urls.length; i += SCORE_BATCH_MAX) {
      const chunk = urls.slice(i, i + SCORE_BATCH_MAX);
      startJob({
        title: t("inbox.scoringN", { n: chunk.length }),
        subtitle: t("inbox.shortlist"),
        kind: "batch-evaluate",
        input: chunk.join("\n"),
        urls: chunk,
        page: "/pipeline",
        batchId,
      });
    }
    setScoredBatchId(batchId);
    setShortlist([]); // sent — the rows leave the inbox once the batch reconciles pipeline.md
  };

  // The parent (PipelineView) renders the rich empty-inbox card; here we always
  // have ≥1 raw posting.
  if (inbox.length === 0) return null;

  return (
    <div className={cn("mx-auto mt-4 max-w-3xl md:flex md:flex-1 md:min-h-0 md:flex-col", shortlist.length > 0 && "pb-28 sm:pb-24")}>
      <div className="md:shrink-0">
        <FacetChips
          within={within}
          setWithin={setWithin}
          sources={sources}
          toggleSource={(s) => setSources((set) => { const n = new Set(set); n.has(s) ? n.delete(s) : n.add(s); return n; })}
          seniorities={seniorities}
          toggleSeniority={(s) => setSeniorities((set) => { const n = new Set(set); n.has(s) ? n.delete(s) : n.add(s); return n; })}
          unscoredOnly={unscoredOnly}
          onToggleUnscoredOnly={() => setUnscoredOnly((v) => !v)}
          locQ={locQ}
          setLocQ={setLocQ}
          kw={kw}
          setKw={setKw}
          salaryMin={salaryMin}
          setSalaryMin={setSalaryMin}
          sortBySalary={sortBySalary}
          onToggleSortBySalary={() => setSortBySalary((v) => !v)}
          availSources={availSources}
          availSeniorities={availSeniorities}
          resultCount={filtered.length}
          totalCount={enriched.length - hiddenCount}
          anyActive={anyFacet}
          // 清空 = 回到默认（ADR-0024 决定 5）：两开关回默认开，其余条件清零——
          // 否则会落入已退役的 fresh-batch 截断视图；清除后的开关状态照常持久化
          onClear={() => { setWithin(null); setSources(new Set()); setSeniorities(new Set()); setLocQ(""); setKw(""); setSalaryMin(null); setUnscoredOnly(true); setSortBySalary(true); }}
        />
      </div>

      {/* batch header: fresh slice by default, or the full filtered set */}
      <div className="mt-4 flex items-baseline justify-between gap-3 md:shrink-0">
        <p className="text-sm font-medium text-foreground">
          {capped
            ? t("inbox.freshWorthLook")
            : anyFacet
              ? filtered.length === 1
                ? t("inbox.matchOne")
                : t("inbox.matches", { n: filtered.length })
              : t("inbox.allRoles")}
        </p>
        {filtered.length > 0 && (
          <button
            type="button"
            onClick={toggleSelectAll}
            className="text-xs text-faint transition-colors hover:text-foreground"
            aria-pressed={allFilteredSelected}
          >
            {allFilteredSelected ? t("inbox.selectNone") : t("inbox.selectAll")}
          </button>
        )}
        {hiddenCount > 0 && (
          <button type="button" onClick={() => setHidden([])} className="text-xs text-faint transition-colors hover:text-foreground">
            {t("inbox.hiddenRestore", { n: hiddenCount })}
          </button>
        )}
      </div>

      {/* multi-select action bar */}
      {selected.size > 0 && (
        <div className="mt-2 flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-sm md:shrink-0">
          <span className="font-medium text-brand tabular-nums">{t("inbox.selected", { n: selected.size })}</span>
          <button type="button" onClick={saveSelected} className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground max-sm:min-h-[44px]">
            {t("inbox.saveToShortlist")}
          </button>
          <button type="button" onClick={skipSelected} className="text-xs text-muted hover:text-foreground max-sm:min-h-[44px]">
            {t("inbox.skipSelected")}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-muted hover:text-foreground max-sm:min-h-[44px]">
            {t("inbox.clear")}
          </button>
        </div>
      )}

      {visible.length > 0 ? (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40 md:min-h-0 md:flex-1 md:overflow-y-auto">
          {visible.map((e) => (
            <TriageRow
              key={e.urlKey}
              job={e.job}
              source={e.source}
              age={e.age}
              scored={resolveRowScore(liveScores.get(e.urlKey), persistedScores.get(e.urlKey))}
              selected={selected.has(e.urlKey)}
              shortlisted={isShortlisted(e.urlKey)}
              onToggleSelect={() => toggleSelect(e.urlKey)}
              onSave={() => save(e.job)}
              onSkip={() => skip(e.job)}
            />
          ))}
        </ul>
      ) : (
        <div className="mt-3 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-10 text-center">
          <p className="font-display text-lg">{t("inbox.noMatches")}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{t("inbox.loosenFilters")}</p>
        </div>
      )}

      {/* "See all N" — only when the fresh batch is capping a larger list */}
      {capped && ordered.length > BATCH && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-3 inline-flex w-full items-center justify-center gap-1 rounded-xl border border-border bg-surface/40 py-2.5 text-sm font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px] md:shrink-0"
        >
          {t("inbox.seeAll", { n: ordered.length })}
        </button>
      )}

      {/* empty-shortlist guidance (only once there's nothing saved) */}
      {shortlist.length === 0 && (
        <p className="mt-4 text-center text-xs text-faint">{t("inbox.saveHint")}</p>
      )}

      {/* undo toast (sits above the tray) */}
      {undo && (
        <div className={cn("fixed inset-x-0 z-40 flex justify-center px-4", shortlist.length > 0 ? "bottom-24 sm:bottom-24" : "bottom-6")}>
          <div className="inline-flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 text-sm shadow-lg">
            <span className="text-muted">{undo.label}</span>
            <button type="button" onClick={() => { undo.fn(); setUndo(null); }} className="inline-flex items-center gap-1 font-medium text-brand max-sm:min-h-[44px]">
              <Undo2 className="size-3.5" /> {t("inbox.undo")}
            </button>
          </div>
        </div>
      )}

      <ShortlistTray
        items={shortlist}
        estimate={estimate}
        hasCli={hasCli}
        onRemove={(url) => setShortlist((s) => s.filter((x) => x.url !== url))}
        onClear={() => setShortlist([])}
        onScore={scoreShortlist}
      />
    </div>
  );
}
