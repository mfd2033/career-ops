"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, Check, X, Clock, AlertTriangle } from "lucide-react";
import { useJobs, type JobItem } from "@/components/jobs/job-store";
import { HeroGlow } from "@/components/hero-glow";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n/context";
import { useJobTiming } from "@/lib/eval-duration-client";
import { EvalTimingPanel } from "@/components/eval-timing-panel";
import { ReportNumLink } from "@/components/report-num-link";
import { goBackOr } from "@/lib/nav-history";
import { formatRunEngine } from "@/lib/cli-labels.mjs";
import { fmtStartedAt } from "@/lib/started-at.mjs";
import { ledgerCardFields } from "@/lib/ledger-display.mjs";
import { fmtDuration } from "@/lib/format";
import { BatchItemList } from "@/components/jobs/batch-item-list";
import { StepTimeline } from "@/components/jobs/step-timeline";

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
  // ADR-0043 运行引擎：本功能前的记录没有这两个字段 → 「未记录」。
  cliId?: string;
  model?: string;
  // ADR-0045 决议 2/6：批量台账行的逐项快照与选中总数；旧行/单次 run 无此
  // 字段，按「无逐项数据」处理，不回填。
  items?: JobItem[];
  total?: number;
  // ADR-0047：单任务终结时折叠落盘的步骤流（工具/状态行）；旧行/批量行无此
  // 字段，按「无步骤流」处理，不回填。
  steps?: { kind: "tool" | "status"; label: string; ts?: number }[];
  // ADR-0046：批量子任务行的归属与报告目标。parentId 存在 = 这是一条子行，
  // 列表隐藏、详情页可解析；reportNum（evaluate）/trackerN（checkup）二选一。
  parentId?: string;
  reportNum?: number;
  trackerN?: string;
};

// ADR-0042 决议 1：运行中每秒走一次的时钟，供「已耗时」显示（不估算、不预测——
// 只显示真实流逝）。
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { jobs } = useJobs();
  const { t } = useI18n();
  const router = useRouter();
  const job = jobs.find((j) => j.id === id);
  // Hooks before the not-found early return; an unknown id just yields nulls.
  const { reportNum, entry } = useJobTiming(job ?? {});
  const subtitleIsNum = !!job?.subtitle && /^#\d+$/.test(job.subtitle);
  const running = job?.status === "running";
  const now = useNow(!!running);

  // ADR-0042 决议 6：服务端批量逐项登记的恢复通道——另一个页签打开详情页、或
  // 本页签流式累积丢失时，凭 open 事件下发的 serverBatchId 每 3s 拉一次登记表。
  const serverBatchId = job?.serverBatchId;
  const [serverItems, setServerItems] = useState<JobItem[]>([]);
  useEffect(() => {
    if (!serverBatchId || !running) return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/batch-items?batchId=${encodeURIComponent(serverBatchId)}`, { cache: "no-store" });
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
  }, [serverBatchId, running]);

  // ADR-0027 follow-up: runs dispatched outside this browser (API, another
  // tab) have no localStorage card — their record lives ONLY in the server
  // run ledger. When the id isn't local, fall back to the ledger so the
  // history page's detail links don't dead-end at "not in memory".
  const [ledgerEntry, setLedgerEntry] = useState<RunLedgerEntry | null>(null);
  const [ledgerLoaded, setLedgerLoaded] = useState(false);
  useEffect(() => {
    if (job) return; // local card wins — nothing to look up
    let alive = true;
    fetch("/api/runs/history")
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((d) => {
        if (!alive) return;
        setLedgerEntry((d.runs as RunLedgerEntry[]).find((r) => r.id === id) ?? null);
      })
      .catch(() => {})
      .finally(() => alive && setLedgerLoaded(true));
    return () => {
      alive = false;
    };
  }, [job, id]);

  if (!job && ledgerEntry) {
    // Terminal-only ledger view: renders the honest subset — status, title,
    // duration, reason — plus, when the ledger carries it, the reconstructed
    // step stream (ADR-0047: single-run steps now persist at terminal time).
    const e = ledgerEntry;
    const ledgerEngine = formatRunEngine(e.cliId, e.model);
    // ADR-0051 补丁（方案 A）：同历史页——服务端兜底标题在读取端派生成可读标题，
    // 否则扩展/CLI 发起的任务页会拿「evaluate <url>」当 H1，而下面一行又重复一遍 url。
    const display = ledgerCardFields({ kind: e.kind, input: e.input, title: e.title, page: e.page, t });
    // ADR-0046：子任务行（带 parentId）的 kind 读作「子任务」，并给报告跳转与返回父批量。
    const isChild = !!e.parentId;
    const kindLabel = isChild ? t("jobs.subtaskKind") : e.kind;
    const checkupHref = e.trackerN ? `/api/checkup-report?n=${encodeURIComponent(e.trackerN)}` : null;
    return (
      <div className="mx-auto max-w-3xl px-6 py-8">
        <button
          type="button"
          onClick={() => goBackOr(router, "/jobs")}
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
        >
          <ArrowLeft className="size-4" /> {t("shared.back")}
        </button>

        <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
          <div className="relative z-10">
            <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
              {e.status === "done" ? (
                <><Check className="size-3 text-emerald-500" /> {t("jobs.statusDone")}</>
              ) : (
                <><X className="size-3 text-red-400" /> {t("jobs.statusError")}</>
              )}
            </p>
            <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{display.title}</h1>
            <p className="mt-1 text-sm text-muted">
              {kindLabel} · {t("jobs.ledgerInput")}: {e.input} · {fmtDuration(Math.round((e.finishedAt - e.startedAt) / 1000))}
            </p>
            {/* ADR-0044：台账行无排队信息，只说始于/止于（与本地卡视图口径一致）。 */}
            {(fmtStartedAt(e.startedAt) || fmtStartedAt(e.finishedAt)) && (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-faint">
                {fmtStartedAt(e.startedAt) && <span>{t("jobs.startedAt", { time: fmtStartedAt(e.startedAt)! })}</span>}
                {fmtStartedAt(e.finishedAt) && <span>{t("jobs.endedAt", { time: fmtStartedAt(e.finishedAt)! })}</span>}
              </p>
            )}
            {/* ADR-0043 决议 4：详情页对缺失明说，不装作知道。 */}
            <p className="mt-1 text-sm">
              {ledgerEngine ? (
                <span className="text-muted" title={t("jobs.runEngineHint")}>
                  {t("jobs.runEngine", { engine: ledgerEngine })}
                </span>
              ) : (
                <span className="text-faint">{t("jobs.runEngineNotRecorded")}</span>
              )}
            </p>
            {display.page && (
              <p className="mt-2">
                <Link href={display.page} className="text-sm text-brand transition-colors hover:underline">
                  {display.page}
                </Link>
              </p>
            )}
            {/* ADR-0046：子任务行给报告跳转（evaluate 站内 /report/{num}，checkup 新标签
                /api/checkup-report）与返回父批量入口；无报告目标（异常缺字段）不显示死链。 */}
            {(e.reportNum != null || checkupHref) && (
              <p className="mt-3 flex flex-wrap items-center gap-3">
                {e.reportNum != null && <ReportNumLink n={String(e.reportNum)} className="text-sm" />}
                {e.reportNum != null && <span className="text-sm text-muted">{t("jobs.viewReport")}</span>}
                {e.reportNum == null && checkupHref && (
                  <Link href={checkupHref} target="_blank" rel="noreferrer" className="text-sm text-brand transition-colors hover:underline">
                    {t("jobs.viewReport")}
                  </Link>
                )}
              </p>
            )}
            {isChild && (
              <p className="mt-3">
                <Link href={`/jobs/${e.parentId}`} className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-brand">
                  <ArrowLeft className="size-3.5" /> {t("jobs.batchChildParent")}
                </Link>
              </p>
            )}
            {e.msg && (
              <p className="mt-3 rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm text-muted">{e.msg}</p>
            )}
            {/* ADR-0045：UI 外发起的批量终结后，ledger-only 视图不再只有状态+
                时长+原因——落盘的逐项快照同口径渲染（本地卡视图零变化）。 */}
            {e.items && e.items.length > 0 && (
              <>
                <h2 className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-muted">{t("jobs.batchItems")}</h2>
                <BatchItemList items={e.items} batchId={e.id} cliId={e.cliId} model={e.model} />
              </>
            )}
            {/* ADR-0047：单任务台账行携带重建的步骤流时，与 live 视图同口径渲染。 */}
            {e.steps && e.steps.length > 0 && <StepTimeline steps={e.steps} />}
          </div>
        </section>
        <p className="mt-4 text-xs text-faint">{t("jobs.ledgerNote")}</p>
      </div>
    );
  }

  if (!job && ledgerLoaded) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <button
          type="button"
          onClick={() => goBackOr(router, "/jobs")}
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
        >
          <ArrowLeft className="size-4" /> {t("shared.back")}
        </button>
        <p className="mt-8 text-sm text-muted">
          {t("jobs.notInMemory")}
        </p>
      </div>
    );
  }

  if (!job) {
    // Ledger fetch still in flight — keep the previous quiet placeholder so a
    // ledger-backed detail never flashes "not in memory" first.
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <button
          type="button"
          onClick={() => goBackOr(router, "/jobs")}
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
        >
          <ArrowLeft className="size-4" /> {t("shared.back")}
        </button>
        <p className="mt-8 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-3.5 animate-spin" /> {t("jobs.ledgerLoading")}
        </p>
      </div>
    );
  }

  // ADR-0043 决议 5：所有状态都显示运行引擎；缺失即明说「未记录」。
  const jobEngine = formatRunEngine(job.cliId, job.model);
  // ADR-0044 诚实时间链：排队于 → 始于 → 止于，缺段省略、不回填。
  //  - 本地卡 startedAt 是派发时刻（含排队段），占槽后才有 runningStartedAt；
  //    池源卡 startedAt 本就是真实执行起点，enqueuedAt 另携带入队时刻。
  //  - 排队态尚无执行起点，只说「排队于」；一旦转 running，两者并列。
  const isQueued = job.status === "queued";
  const queuedClock = fmtStartedAt(job.enqueuedAt ?? (isQueued ? job.startedAt : NaN));
  const execStartMs = job.runningStartedAt ?? job.startedAt;
  const startedClock = isQueued ? null : fmtStartedAt(execStartMs);
  const endedClock = job.endedAt != null ? fmtStartedAt(job.endedAt) : null;
  // ADR-0042 决议 5：本地累积 ∪ 服务端登记表（本地优先——流式事件更实时；
  // 服务端补跨页签/恢复场景）。按 key 幂等合并。
  const itemMap = new Map<string, JobItem>();
  for (const it of serverItems) itemMap.set(it.key, it);
  for (const it of job.items ?? []) itemMap.set(it.key, it);
  const batchItems = [...itemMap.values()];
  const showBatchPanel = batchItems.length > 0 || job.batchPos != null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* 返回跟随会话历史（ADR-0019）；无应用内前一页时兜底回工作器列表——
          工作器详情页不是管道页，不固定回 /pipeline。 */}
      <button
        type="button"
        onClick={() => goBackOr(router, "/jobs")}
        className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand"
      >
        <ArrowLeft className="size-4" /> {t("shared.back")}
      </button>

      <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
        {job.status === "running" && <HeroGlow />}
        <div className="relative z-10">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
            {job.interruptedAt != null ? (
              // ADR-0042 决议 7：中断残留冻结显示——不转圈，不假装在跑；
              // 中断发生在收尾段时把最后已知阶段一并说出来。
              <>
                <AlertTriangle className="size-3 text-amber-500" /> {t("jobs.interrupted")}
                {job.phase === "finalizing" && <> · {t("jobs.phaseFinalizing")}</>}
              </>
            ) : job.status === "running" ? (
              <>
                <Loader2 className="size-3 animate-spin text-brand" /> {t("jobs.statusWorking")}
                {/* ADR-0042 决议 1：粗阶段徽章 + 真实已耗时（零估算）。ADR-0044：
                    已耗时从真实执行起点起算，排队等待不计入运行时长。 */}
                {job.phase === "finalizing" && <> · {t("jobs.phaseFinalizing")}</>}
                <> · {fmtDuration(Math.max(0, Math.round((now - execStartMs) / 1000)))}</>
              </>
            ) : job.status === "queued" ? (
              <><Clock className="size-3 text-zinc-400" /> {t("jobs.queued")}{job.queuedPos != null ? ` · ${t("jobs.queuedPos", { n: job.queuedPos })}` : ""}</>
            ) : job.status === "done" ? (
              <><Check className="size-3 text-emerald-500" /> {t("jobs.statusDone")}</>
            ) : (
              <><X className="size-3 text-red-400" /> {t("jobs.statusError")}</>
            )}
          </p>
          <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">
            {job.title}
            {/* The report jump, exactly once: the /jobs rows carry it beside the
                title, and pool cards carry it AS the "#N" subtitle below — never
                both (ADR-0018). */}
            {reportNum && !subtitleIsNum && (
              <>
                {" "}
                <ReportNumLink
                  n={reportNum}
                  className="align-middle text-sm font-normal text-faint transition-colors hover:text-brand"
                />
              </>
            )}
          </h1>
          {subtitleIsNum && reportNum ? (
            <p className="mt-1 text-sm text-muted">
              <Link href={`/report/${reportNum}`} className="transition-colors hover:text-brand">
                {job.subtitle}
              </Link>
            </p>
          ) : (
            job.subtitle && <p className="mt-1 text-sm text-muted">{job.subtitle}</p>
          )}
          <p className="mt-2 text-xs" title={t("jobs.runEngineHint")}>
            {jobEngine ? (
              <span className="text-muted">{t("jobs.runEngine", { engine: jobEngine })}</span>
            ) : (
              <span className="text-faint">{t("jobs.runEngineNotRecorded")}</span>
            )}
          </p>
          {/* ADR-0044：诚实时间链，缺段省略。 */}
          {(queuedClock || startedClock || endedClock) && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-faint">
              {queuedClock && <span>{t("jobs.queuedAt", { time: queuedClock })}</span>}
              {startedClock && <span>{t("jobs.startedAt", { time: startedClock })}</span>}
              {endedClock && <span>{t("jobs.endedAt", { time: endedClock })}</span>}
            </p>
          )}
          {job.result?.score != null && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Badge tone={job.result.tone}>{job.result.score}/5</Badge>
              {job.result.summary && <span className="text-sm text-muted">{job.result.summary}</span>}
            </div>
          )}
        </div>
      </section>

      {/* ADR-0042 决议 5：批量任务——计数行（来自 [i/n] status）+ 逐项点亮清单 */}
      {showBatchPanel && (
        <div className="mt-6">
          <div className="flex items-center gap-2 text-sm text-muted">
            {running && job.batchPos != null && <Loader2 className="size-3.5 animate-spin text-brand" />}
            {job.batchPos != null && (
              <span>{t("jobs.batchProgress", { i: job.batchPos.i, n: job.batchPos.n })}</span>
            )}
          </div>
          {batchItems.length > 0 && (
            <>
              <h2 className="mt-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                {t("jobs.batchItems")}
              </h2>
              {/* ADR-0045：渲染抽成共享组件（与历史列表展开、ledger-only 视图
                  同一 JobItem 口径），这里不再 inline 重复一份。 */}
              <BatchItemList items={batchItems} batchId={job.serverBatchId} cliId={job.cliId} model={job.model} />
            </>
          )}
        </div>
      )}

      <StepTimeline steps={job.steps} />
      {/* ADR-0042：「思考中…」退役为最后兜底——仅当运行中且无任何步骤/中断时。 */}
      {job.status === "running" && job.steps.length === 0 && job.interruptedAt == null && (
        <ol className="mt-6 space-y-2">
          <li className="flex items-center gap-2.5 text-sm text-muted">
            <Loader2 className="size-3.5 animate-spin text-brand" /> {t("jobs.thinking")}
          </li>
        </ol>
      )}
      {job.status === "queued" && (
        <ol className="mt-6 space-y-2">
          <li className="flex items-center gap-2.5 text-sm text-faint">
            <Clock className="size-3.5" /> {t("jobs.queuedHint")}
          </li>
        </ol>
      )}

      <EvalTimingPanel entry={entry} />

      {job.text && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{t("jobs.output")}</h2>
          <div className="report-prose mt-3 rounded-2xl border border-border bg-surface/40 p-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.text}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
