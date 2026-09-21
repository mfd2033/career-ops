"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, AlertTriangle, Loader2, Trash2, Clock, ChevronRight } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { pillTone } from "@/components/jobs/worker-pills";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";
import { fmtDuration } from "@/lib/format";
import { fmtStartedAt } from "@/lib/started-at.mjs";
import { doneDurationSeconds, useJobTiming } from "@/lib/eval-duration-client";
import { ReportNumLink } from "@/components/report-num-link";
import { formatRunEngine } from "@/lib/cli-labels.mjs";
import { ledgerOnlyRuns } from "@/lib/ledger-merge.mjs";
import { batchSummary } from "@/lib/batch-summary.mjs";
import { mergeBatchItems, shouldPollBatch } from "@/lib/batch-live.mjs";
import { BatchItemList } from "@/components/jobs/batch-item-list";
import type { Job, JobItem } from "@/components/jobs/job-store";

const TONE_CHIP = {
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  bad: "bg-red-500/15 text-red-700 dark:text-red-400",
  muted: "bg-surface-hover text-muted",
} as const;

const STATUS_LABEL: Record<string, string> = {
  running: "jobs.statusRunning",
  queued: "jobs.queued",
  done: "jobs.statusDone",
  error: "jobs.statusError",
};

/** Shape of one server run-ledger entry (producer: web/src/lib/run-ledger.mjs
 *  via GET /api/runs/history — ADR-0027 follow-up observability fix). */
type RunLedgerEntry = {
  id: string;
  kind: string;
  input: string;
  title: string;
  page?: string;
  status: "done" | "error";
  startedAt: number;
  finishedAt: number;
  msg?: string;
  // ADR-0043 运行引擎：本功能前的记录没有这两个字段（按「未记录」处理）。
  cliId?: string;
  model?: string;
  // ADR-0045 决议 2/6：批量行的逐项快照与选中总数。功能前的旧行没有这两个
  // 字段（tolerant reader 照常解析），展示端按「无逐项数据」处理，不回填。
  items?: JobItem[];
  total?: number;
};

export default function JobsHistory() {
  const { jobs, clearFinished } = useJobs();
  const { t } = useI18n();

  // Server run ledger (ADR-0027 follow-up): terminated runs dispatched outside
  // this browser (API, script, another tab) exist only in the server ledger.
  // Merge them in, deduped by runId — a card that knows its runId wins (it has
  // richer live state); ledger-only rows fill the gaps so a finished checkup
  // can never vanish from history again.
  const [ledgerRuns, setLedgerRuns] = useState<RunLedgerEntry[]>([]);
  useEffect(() => {
    fetch("/api/runs/history")
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((d) => setLedgerRuns(d.runs ?? []))
      .catch(() => {});
  }, []);

  // ADR-0045 推定结论：去重键扩展到批量——单次 run 认 runId，批量认
  // serverBatchId（= 批量台账行的 id），同一批量本地卡胜出、绝不出双行。
  const ledgerOnly: Job[] = ledgerOnlyRuns(jobs, ledgerRuns).map((r) => ({
    id: r.id,
    title: r.title,
    page: r.page,
    input: r.input,
    kind: r.kind,
    runId: r.id,
    cliId: r.cliId,
    model: r.model,
    status: r.status === "done" ? "done" : "error",
    steps: [],
    text: r.msg || "",
    startedAt: r.startedAt,
    endedAt: r.finishedAt,
    // ADR-0045：台账落盘的逐项快照随 ledger-only 行带出，供列表展开/详情页
    // 消费；旧行无 items 时为 undefined，展示端自行保持诚实空白。
    items: r.items,
    batchTotal: r.total,
  }));
  const merged = [...jobs, ...ledgerOnly].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">{t("jobs.workers")}</h1>
          <p className="mt-1 text-sm text-muted">
            {t("jobs.historyIntro")}<span className="tabular-nums">{merged.length}</span>{t("jobs.total")}
          </p>
        </div>
        {merged.some((j) => j.status !== "running" && j.status !== "queued") && (
          <button
            onClick={clearFinished}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <Trash2 className="size-3.5" /> {t("jobs.clearFinished")}
          </button>
        )}
      </div>

      {merged.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center text-sm text-muted">
          {t("jobs.empty")}
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
          {merged.map((j) => (
            <JobsRow key={j.id} job={j} />
          ))}
        </ul>
      )}
    </div>
  );
}

// One history row as its own component: the 评估用时 + report-number resolution
// needs hooks (useJobTiming), which can't be called inside the map callback.
function JobsRow({ job: j }: { job: Job }) {
  const { t } = useI18n();
  const tone = pillTone(j);
  const { reportNum, entry } = useJobTiming(j);
  const secs = j.status === "done" ? doneDurationSeconds(entry, j) : null;
  // The pool cards carry "#N" as their subtitle — render it as the report jump
  // instead of duplicating it beside the title.
  const subtitleIsNum = !!j.subtitle && /^#\d+$/.test(j.subtitle);
  // ADR-0043 运行引擎：列表里缺失不占位（详情页才写「未记录」）。
  const engine = formatRunEngine(j.cliId, j.model);
  const engineText = engine ? t("jobs.runEngine", { engine }) : null;
  // ADR-0044 始于：优先真实执行起点（本地卡排队后落的 runningStartedAt），
  // 否则回退 startedAt；ledger-only 行的 startedAt 来自服务端台账。缺失不占位。
  // 排队态尚无执行起点，改说「排队于」（与内联卡/详情页同口径），不谎称「始于」。
  const isQueued = j.status === "queued";
  const startedClock = isQueued ? null : fmtStartedAt(j.runningStartedAt ?? j.startedAt);
  const queuedClock = isQueued ? fmtStartedAt(j.enqueuedAt ?? j.startedAt) : null;
  // ADR-0045 决议 1/7/9：批量行可展开逐项清单——有 items 才有箭头（无数据不
  // 回填、不伪造），默认折叠；chevron 只切换展开态，行其余区域仍迚详情页。
  const isBatch = j.kind === "batch-evaluate" || j.kind === "batch-checkup";
  const isRunning = j.status === "running";
  const [batchOpen, setBatchOpen] = useState(false);
  // ADR-0045 决议 8：运行中批量展开时每 3s 轮询服务端登记表（与详情页同一
  // `/api/batch-items` 通道）；折叠/终态不拉，卸载与折叠都清定时器。瞬时失败
  // 静默等下个 tick（与详情页容错同口径，不闪错误态）。
  const [serverItems, setServerItems] = useState<JobItem[]>([]);
  useEffect(() => {
    if (!shouldPollBatch({ open: batchOpen, running: isBatch && isRunning, serverBatchId: j.serverBatchId })) return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/batch-items?batchId=${encodeURIComponent(j.serverBatchId!)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { items?: JobItem[] };
        if (alive && Array.isArray(data.items)) setServerItems(data.items);
      } catch {
        /* transient — next tick retries */
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [batchOpen, isBatch, isRunning, j.serverBatchId]);
  // 实时清单 = 登记表快照 ∪ 本地流累积（同键本地胜出）；折叠摘要也从此现算，
  // 运行中与终态同口径。run 终结后定时器停、已拉到的条目不回退不闪空。
  const batchItems = isBatch ? mergeBatchItems(serverItems, j.items) : [];
  const summary = isBatch ? batchSummary(batchItems, j.batchTotal) : null;
  // 箭头只在有数据时给（无数据不回填不伪造）；运行中的批量哪怕首项未出也
  // 允许展开——空态占位正是实时点亮的入口。
  const expandable = isBatch && (!!summary?.hasItems || (isRunning && !!j.serverBatchId));
  return (
    <li>
      <div className="flex items-stretch">
        {expandable && (
          <button
            type="button"
            onClick={() => setBatchOpen((o) => !o)}
            aria-expanded={batchOpen}
            title={batchOpen ? t("jobs.batchCollapse") : t("jobs.batchExpand")}
            aria-label={batchOpen ? t("jobs.batchCollapse") : t("jobs.batchExpand")}
            className="flex items-center px-1.5 text-faint transition-colors hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", batchOpen && "rotate-90")} />
          </button>
        )}
      <Link href={`/jobs/${j.id}`} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover">
        <span className="hidden shrink-0 text-xs capitalize text-faint sm:block">{t(STATUS_LABEL[j.status] ?? j.status)}</span>
        {j.status === "queued" && j.queuedPos != null && (
          <span className="shrink-0 text-xs tabular-nums text-faint">#{j.queuedPos}</span>
        )}
        {j.status === "queued" ? (
          <Clock className="size-4 shrink-0 text-zinc-400" />
        ) : j.status === "running" ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
        ) : j.status === "error" ? (
          <AlertTriangle className="size-4 shrink-0 text-red-400" />
        ) : (
          <Check className="size-4 shrink-0 text-emerald-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {j.title}
            {reportNum && !subtitleIsNum && (
              <>
                {" "}
                <ReportNumLink n={reportNum} className="text-xs font-normal text-faint transition-colors hover:text-brand" />
              </>
            )}
          </div>
          {summary?.hasItems ? (
            // ADR-0045 决议 9：折叠态也一眼看到批量结果计数（溢出截断时 n 以 total 为准）。
            <div className="truncate text-xs text-muted">{t("jobs.batchCounters", { n: summary.n, ok: summary.ok, failed: summary.failed })}</div>
          ) : subtitleIsNum ? (
            <div className="truncate text-xs text-muted">
              <ReportNumLink n={reportNum!} className="text-xs text-muted transition-colors hover:text-brand" />
            </div>
          ) : (
            (j.subtitle || j.result?.summary) && <div className="truncate text-xs text-muted">{j.result?.summary || j.subtitle}</div>
          )}
          {engineText && (
            <div className="truncate text-[11px] text-faint" title={`${engineText} — ${t("jobs.runEngineHint")}`}>
              {engineText}
            </div>
          )}
        </div>
        {queuedClock && (
          <span className="hidden shrink-0 items-center gap-1 text-xs tabular-nums text-faint sm:flex" title={t("jobs.queuedAt", { time: queuedClock })}>
            {t("jobs.queuedAt", { time: queuedClock })}
          </span>
        )}
        {startedClock && (
          <span className="hidden shrink-0 items-center gap-1 text-xs tabular-nums text-faint sm:flex" title={t("jobs.startedAt", { time: startedClock })}>
            {t("jobs.startedAt", { time: startedClock })}
          </span>
        )}
        {secs != null && (
          <span className="hidden shrink-0 items-center gap-1 text-xs tabular-nums text-faint sm:flex" title={t("jobs.evalDuration")}>
            <Clock className="size-3" /> {fmtDuration(secs)}
          </span>
        )}
        {j.result?.score != null && (
          <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums", TONE_CHIP[tone])}>
            {j.result.score}/5
          </span>
        )}
        <span className="hidden shrink-0 text-xs capitalize text-faint sm:block">{t(STATUS_LABEL[j.status] ?? j.status)}</span>
      </Link>
      </div>
      {expandable && batchOpen && (
        <div className="px-4 pb-4 pl-9">
          {batchItems.length > 0 ? (
            <BatchItemList items={batchItems} batchId={j.serverBatchId || j.runId} cliId={j.cliId} model={j.model} />
          ) : (
            <p className="mt-2 text-xs text-muted">{t("jobs.batchWaiting")}</p>
          )}
        </div>
      )}
    </li>
  );
}
