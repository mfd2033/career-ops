"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, History } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { WorkerCard, pillTone, TONE } from "@/components/jobs/worker-card";
import { RetryJobButton } from "@/components/jobs/retry-job-button";
import { pickTrayJobs } from "@/lib/tray-jobs.mjs";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

// Back-compat re-exports (app/jobs/page.tsx imports pillTone from here).
export { pillTone, TONE };

// 桌面端侧栏（fitToHeight）没有固定张数：按分配给列表的像素高度决定能完整
// 显示几张卡，让整侧栏恰好填满、不出现纵向滚动条。每张卡高度可变（有无用时/
// 引擎行），故用一个不可见的 ghost 列表量出每张真实高度再累加。移动端抽屉沿用
// 原来的固定名额，交给抽屉自身滚动。
const TRAY_LIMIT = 6;
// space-y-1.5 = 6px 行间距，累加高度时要算上。
const LIST_GAP = 6;

export function WorkerPills({ fitToHeight = false }: { fitToHeight?: boolean }) {
  const { jobs, ledgerOnlyJobs, cancelJob, clearFinished } = useJobs();
  const pathname = usePathname();
  const { t } = useI18n();

  // 托盘合并纯台账卡：跨页签/扩展发起的终态任务以前只活在 /jobs 主列表，
  // 托盘彻底看不见。名额分配（进行中永不截断，终态新者优先填）在
  // lib/tray-jobs.mjs；ledger-only 卡不挂 ✕（对台账行无效的死按钮）。
  // fitToHeight 时先取全量（limit 传 Infinity），再由高度测量裁到能放下的张数；
  // 裁切只动终态卡，进行中卡永远保留（pickTrayJobs 规则 + 下方 activeCount 下限）。
  const full = useMemo(
    () => pickTrayJobs(jobs, ledgerOnlyJobs, fitToHeight ? Number.MAX_SAFE_INTEGER : TRAY_LIMIT),
    [jobs, ledgerOnlyJobs, fitToHeight],
  );

  const listRef = useRef<HTMLUListElement>(null);
  const ghostRef = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState(TRAY_LIMIT);

  // 按可用高度重算可完整显示的张数：量 ghost 里每张真实高度累加，
  // 直到超出可见列表 clientHeight。是否保留进行中卡的下限在渲染处（visibleCount）处理。
  const recompute = useCallback(() => {
    if (!fitToHeight) return;
    const container = listRef.current;
    const ghost = ghostRef.current;
    if (!container || !ghost) return;
    const avail = container.clientHeight;
    const items = Array.from(ghost.children) as HTMLElement[];
    let used = 0;
    let count = 0;
    for (const it of items) {
      // 用 getBoundingClientRect 的小数高度累加（offsetHeight 会四舍五入低估真实
      // 高，末张卡易被内层列表裁掉几个像素→误弹滚动条）；留 1px 安全余量，宁可少一张。
      const h = it.getBoundingClientRect().height;
      const add = h + (count > 0 ? LIST_GAP : 0);
      if (used + add <= avail - 1) {
        used += add;
        count += 1;
      } else {
        break;
      }
    }
    // 放不下一张时 count=0：有进行中卡则由 visibleCount 下限托底（列表内部滚动），
    // 无进行中卡时 tray 为空、卡片区不渲染（头部始终保留，保证可用高度不随显隐抖动）。
    setFit(count);
  }, [fitToHeight, full]);

  useEffect(() => {
    if (!fitToHeight) return;
    recompute();
    const container = listRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(recompute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [fitToHeight, recompute]);

  if (full.length === 0) return null;
  // 进行中卡永不裁掉（activeCount 下限）。只要还有卡数据就不因“放得下几张”而卸载
  // 本区（否则 ResizeObserver 目标消失、fit 永久卡在 0，放大窗口也回不来）：头部
  // 与测量容器始终渲染，卡放不下时只是可见列表为空。
  const activeCount = full.filter((j) => j.status === "running" || j.status === "queued").length;
  const visibleCount = fitToHeight ? Math.max(activeCount, fit) : full.length;
  const tray = full.slice(0, visibleCount);
  const running = tray.filter((j) => j.status === "running" || j.status === "queued").length;
  const finished = tray.length - running;

  const renderItem = (j: (typeof full)[number]) => {
    const active = pathname === `/jobs/${j.id}`;
    return (
      <li key={j.id}>
        <Link
          href={`/jobs/${j.id}`}
          className={cn(
            "group block rounded-lg border px-2.5 py-2 transition-colors",
            active ? "border-brand/50 bg-brand-soft" : "border-border bg-surface/60 hover:bg-surface-hover",
          )}
        >
          <WorkerCard
            job={j}
            variant="tray"
            trailing={
              // 纯台账卡没有本地可删状态（✕ 点了台账行还在，下次轮询
              // 又合并回来），不渲染；RetryJobButton 凭 canRetryJob 也自守卫
              // 渲染 null。故 ledgerOnly 卡整个 trailing 不占位。
              j.ledgerOnly ? undefined : (
              // ADR-0061：侧栏托盘与 /jobs 行、详情页同口径——error 卡除了
              // 取消/忽略的 ✕，还要能一键重试。RetryJobButton 凭 canRetryJob
              // 自守卫（非 error / 池源 / ledger-only 批量一律渲染 null），
              // 故这里无条件挂上，只在可重试时占位。onClick 内部已 preventDefault
              // 阻止外层 Link 跳详情。
              <span className="flex items-center gap-0.5">
                <RetryJobButton job={j} className="opacity-0 transition-opacity group-hover:opacity-100" />
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    cancelJob(j.id);
                  }}
                  className="text-faint opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  title={j.status === "queued" || j.status === "running" ? t("jobs.cancelQueued") : t("jobs.dismissJob")}
                  aria-label={j.status === "queued" || j.status === "running" ? t("jobs.cancelQueued") : t("jobs.dismissJob")}
                >
                  <X className="size-3" />
                </button>
              </span>
              )
            }
          />
        </Link>
      </li>
    );
  };

  return (
    <div
      className={cn(
        // fitToHeight 时整区是 flex-1 测量盒，且始终带分隔线/上边距/头部（高度固定），
        // 这样被观测的列表可用高度不随「卡片/头部是否渲染」变化，消除 fit 反馈抖动；
        // 卡放不下时只是标签下为空。移动端保持原样式。
        fitToHeight
          ? "mt-4 flex min-h-0 flex-1 flex-col border-t border-border pt-3"
          : "mt-4 border-t border-border pt-3",
      )}
    >
      <div className={cn("mb-2 flex items-center gap-2 px-1", fitToHeight && "shrink-0")}>
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">{t("jobs.workers")}</span>
        {running > 0 && <span className="text-[10px] tabular-nums text-brand">{t("jobs.running", { n: running })}</span>}
        <Link href="/jobs" className="ml-auto text-faint transition-colors hover:text-foreground" title={t("jobs.historyTitle")} aria-label={t("jobs.historyAria")}>
          <History className="size-3.5" />
        </Link>
        {finished > 0 && (
          <button onClick={clearFinished} className="text-[10px] text-faint transition-colors hover:text-foreground" title={t("jobs.clearFinished")}>
            {t("jobs.clear")}
          </button>
        )}
      </div>
      {fitToHeight ? (
        // 相对容器里：可见列表 flex-1 min-h-0 拿到确切可用高度。
        // ghost 列表用于量每张真实高度（卡高可变），但它必须对侧栏的溢出区零贡献：
        // 用 absolute + h-0 overflow-hidden 包裹，高度为 0 的盒子裁掉内容，既不撑大
        // aside 的 scrollHeight、也不触发 Chrome scroll anchoring 位移；盒内子项仍按
        // 自身高度参与布局，offsetHeight 可正常读取。宽度 inset-x-0 与可见列表一致。
        // 进行中卡多于可用高度时可见列表内部滚动（overflow-y-auto）——此时无法完全不出
        // 滚动条，但至少不会把进行中的工作裁掉，侧栏整体仍不滚（overflow-anchor:none 防位移）。
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ul ref={listRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto [overflow-anchor:none]">
            {tray.map(renderItem)}
          </ul>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-0 overflow-hidden"
            style={{ visibility: "hidden" }}
          >
            <ul ref={ghostRef} className="space-y-1.5">
              {full.map(renderItem)}
            </ul>
          </div>
        </div>
      ) : (
        <ul className="space-y-1.5">{tray.map(renderItem)}</ul>
      )}
    </div>
  );
}
