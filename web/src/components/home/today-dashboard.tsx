"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CalendarDays, CircleHelp, Sparkles, ArrowRight } from "lucide-react";
import { instrumentSerif } from "@/lib/fonts";
import { HeroGlow } from "@/components/hero-glow";
import type { Application, InboxJob } from "@/lib/career-ops";
import type { DiscoveredOffer } from "@/lib/explore";
import { DiscoveryCard } from "@/components/explore/discovery-card";
import { CompanyLogo } from "@/components/company-logo";
import { FollowUpCard, type FollowUp } from "@/components/home/follow-up-card";
import { DecisionCard } from "@/components/home/decision-card";
import { QuickEvaluate } from "@/components/quick-evaluate";
import { useExplore } from "@/components/explore/explore-provider";
import { useI18n } from "@/lib/i18n/context";
import { MAX_OFFER_LIMIT } from "@/lib/whats-new.mjs";

/** 是否已排进投递计划：填了合法的 Planned 日期（YYYY-MM-DD）。首页「Awaiting
 *  your decision」与「投递计划」两个分区据此互斥，避免同一行重复出现。 */
function hasPlannedDate(a: Application) {
  return !!a.planned && /^\d{4}-\d{2}-\d{2}$/.test(a.planned);
}

// 常用招聘网站快捷入口：静态、始终可见，即使「今日全部处理完」也保留一个
// 主动浏览的下一步。站点名与 URL 是专有名词/技术字面量，保留原文不翻译。
// logo 用本地静态资源（web/public/portals/*.png，透明底高清图标），离线可用、
// 零网络；host 仅作展示（真实可访问域名）。
const PORTALS = [
  { name: "Boss直聘", host: "zhipin.com", url: "https://www.zhipin.com/", logo: "/portals/zhipin.png" },
  { name: "智联招聘", host: "zhaopin.com", url: "https://www.zhaopin.com/", logo: "/portals/zhaopin.png" },
  { name: "猎聘", host: "liepin.com", url: "https://c.liepin.com/", logo: "/portals/liepin.png" },
] as const;

// The retention "Today": a dual-loop action queue (the maintainer's
// "N new matches this week · M follow-ups due"). SUPPLY loop = fresh free-scan
// matches (zero tokens, /api/whats-new); DEMAND loop = follow-ups due
// (/api/followups). Each item one-tap actionable. Home stays a VIEW over the
// canonical files — every action dispatches a real registry action / route.
export function TodayDashboard({
  applications,
  inbox,
  inBetween,
}: {
  applications: Application[];
  inbox: InboxJob[];
  inBetween: boolean;
}) {
  const [followups, setFollowups] = useState<FollowUp[]>([]);
  const [overdue, setOverdue] = useState(0);
  const [fresh, setFresh] = useState<DiscoveredOffer[]>([]);
  // explore 结果区「移除」的记录（removed 集合，显示层处置）。供应回路是服务端
  // 读 scan-history 算出来的，天然看不到浏览器里的移除，所以首页要读同一份记录再挡一次。
  // 直接订阅 shell 级 ExploreProvider 的 removed（单一事实源），而不是另读一份
  // localStorage：单卡 ✕ 与批量「移除所选」都只改 provider 状态，storage 事件在同
  // tab 内不触发，自建副本会漏掉本 tab 的即时移除（用户报的今日页点 ✕ 无反应）。
  const { removed, syncRemovedFromStorage } = useExplore();
  const router = useRouter();
  const { t, lang } = useI18n();
  const dateLabel = useMemo(() => new Date().toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { weekday: "long", month: "short", day: "numeric" }), [lang]);

  const refetch = useCallback(() => {
    fetch("/api/followups")
      .then((r) => r.json())
      .then((d) => {
        setFollowups(Array.isArray(d.entries) ? d.entries : []);
        setOverdue(d.metadata?.overdue ?? d.entries?.length ?? 0);
      })
      .catch(() => {});
    // 取满 explore「查看全部」同一上限：两边拿到的是同一批行、同一个渲染天花板，
    // 「查看全部 N」的 N 才可能等于点进去后真实看到的行数。服务端 count 是 7 天窗口
    // 的完整总数，远超可渲染上限，拿它报数会变成一个点不进去的承诺（用户报的 724）。
    fetch(`/api/whats-new?limit=${MAX_OFFER_LIMIT}`)
      .then((r) => r.json())
      .then((d) => {
        setFresh(Array.isArray(d.offers) ? d.offers : []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refetch();
    // A worker (evaluate/pdf) just wrote a real tracker row — refresh the server
    // snapshot (applications/inbox props) + the client loops so the freshly-scored
    // role appears in "Awaiting your decision" without a manual reload.
    const onDone = () => {
      router.refresh();
      refetch();
    };
    window.addEventListener("co-job-done", onDone);
    return () => window.removeEventListener("co-job-done", onDone);
  }, [refetch, router]);

  // 另一个 tab 里移除/恢复时本 tab 的 provider 不会自动跟（storage 事件只在源 tab
  // 之外触发），监听同一事件并重读 localStorage 回灌单一事实源；同 tab 内的变化由
  // removed 引用变化直接驱动。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "career-ops:explore-removed") syncRemovedFromStorage();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [syncRemovedFromStorage]);

    // Awaiting decision: scored (Evaluated) but no terminal status yet, and not
    // already scheduled into 投递计划 (section B2) — a planned row shows there,
    // so don't duplicate it here.
    const awaiting = useMemo(
      () => applications.filter((a) => /^evaluat/i.test(a.status) && !hasPlannedDate(a)).slice(0, 6),
      [applications],
    );
    // 投递计划：Evaluated 且填了 Planned 日期，按本地今/明/未来分组（同日按文件行序）。
    const plannedGroups = useMemo(() => {
      const dt = new Date();
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const todayStr = fmt(dt);
      const tmr = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1);
      const tomorrowStr = fmt(tmr);
      const apps = applications
        .filter((a) => /^evaluat/i.test(a.status) && hasPlannedDate(a))
        .sort((a, b) => ((a.planned ?? "") < (b.planned ?? "") ? -1 : (a.planned ?? "") > (b.planned ?? "") ? 1 : 0));
      return {
        today: apps.filter((a) => a.planned === todayStr),
        tomorrow: apps.filter((a) => a.planned === tomorrowStr),
        later: apps.filter((a) => (a.planned ?? "") > tomorrowStr),
      };
    }, [applications]);

  const visibleFresh = useMemo(() => fresh.filter((o) => !removed.has(o.url)), [fresh, removed]);
  // 报「实际能看到的行数」，而不是服务端 7 天窗口的完整 count：offers 已被上限截断，
  // count 里的行在 explore 同样渲染不出来。用 count 会让「查看全部 724」点进去只有
  // 十几条（用户报的不一致）。这个数与 explore 结果区头部计数同源同口径。
  const newThisWeek = visibleFresh.length;
  // 投递计划里的待投项也算「有需要你处理的事」：已排计划的岗位不再进 awaiting，
  // 若只看 awaiting 会误判为空并弹出「全部处理完」卡片。
  const plannedCount = plannedGroups.today.length + plannedGroups.tomorrow.length + plannedGroups.later.length;
  const allClear = newThisWeek === 0 && overdue === 0 && awaiting.length === 0 && plannedCount === 0;
  const inboxUrls = useMemo(() => new Set(inbox.map((j) => j.url)), [inbox]);

  return (
    // 一屏自适应（md+）：在桌面/最大化窗口下整页锁定视口高度、不产生文档级滚动条，
    // 纵向空间用两列网格 + 列内（隐藏滚动条的）滚动兜底。窄屏（<md）回退为自然高度
    // 的单列堆叠，保留原有纵向滚动，不裁剪内容。
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-6 py-6 max-sm:pb-24 md:h-screen md:overflow-hidden">
      <section className="dot-bg relative shrink-0 overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-7 md:px-9 md:py-8">
        <HeroGlow />
        {/* Readability scrim between the animated glow (z-0) and the copy (z-10). */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] bg-surface/55 backdrop-blur-[2px] dark:bg-background/45" />
        <div className="relative z-10 flex flex-col gap-6 md:flex-row md:items-start md:justify-between md:gap-10">
          <div className="min-w-0">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> {t("home.todayLabel")} · <span className="tabular-nums">{dateLabel}</span>
          </p>
          <h1 className={`${instrumentSerif.className} mt-3 text-4xl leading-[1.05] text-landing md:text-5xl`}>
            {allClear ? (
              <>{t("home.allCaughtUp")}</>
            ) : (
              <>
                {newThisWeek > 0 && (
                  <>{t(newThisWeek === 1 ? "home.newMatchOne" : "home.newMatches", { n: newThisWeek })}</>
                )}
                {newThisWeek > 0 && overdue > 0 && <span className="text-faint"> · </span>}
                {overdue > 0 && (
                  <>{t(overdue === 1 ? "home.followUpDueOne" : "home.followUpsDue", { n: overdue })}</>
                )}
                {(newThisWeek > 0 || overdue > 0) && plannedCount > 0 && <span className="text-faint"> · </span>}
                {plannedCount > 0 && (
                  <>{t(plannedCount === 1 ? "home.plannedOne" : "home.plannedMany", { n: plannedCount })}</>
                )}
              </>
            )}
          </h1>
          <p className="mt-4 max-w-xl text-sm text-muted">
            {allClear ? t("home.allClearSub") : t("home.actionQueueSub")}
          </p>
          {inBetween && <QuickEvaluate />}
          </div>

          {/* D. 常用招聘网站导航：移到 hero 右上角，一行三个图标按钮，主 CTA 按钮排其下方。
              站点名走 aria-label/title（hover 提示），不再占版面。
              静态快捷入口，始终可见，即使今日清空也保留主动浏览的一步。 */}
          <div className="flex shrink-0 flex-col gap-4 md:mt-1 md:items-end">
            <div className="flex items-center gap-2.5">

            {PORTALS.map((p) => (
              <a
                key={p.url}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${p.name} — ${t("home.portalOpenNewTab")}`}
                title={`${p.name} — ${t("home.portalOpenNewTab")}`}
                className="group flex items-center justify-center rounded-xl border border-border bg-surface/40 p-1.5 transition-colors hover:border-brand/40 hover:bg-surface/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                {/* hover 只对图标做透明度过渡，不改尺寸/内边距，避免布局偏移。 */}
                <CompanyLogo name={p.name} src={p.logo} size={56} imgPadding={0} bareTile className="shrink-0 opacity-90 transition-opacity group-hover:opacity-100" />
              </a>
            ))}
            </div>
            <div className="flex flex-wrap gap-2.5">
              <Link href="/explore" className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 max-sm:min-h-[44px]">
                {t("home.findNewRoles")} <ArrowRight className="size-4" />
              </Link>
              <Link href="/pipeline" className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]">
                {t("home.openPipeline")}
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* 主体：桌面（md+）2×2 网格——左上「待跟进」、左下「等待你的决定」，右上「投递
          计划」、右下「本周新匹配」（与「等待你的决定」同排，占其右侧）。第一行定高
          （38vh，与原列表封顶同口径）+ 区块内滚动，避免长列表把第二行挤没；两栏行底
          对齐，不再一边长一边短（UI 审计 2026-10-31 FAIL #15）。第二行吃掉剩余纵向空间、
          内部滚动。窄屏（<md）回退单列堆叠，DOM 顺序即视觉顺序：待跟进 → 等待你的决定
          → 投递计划 → 本周新匹配。 */}
      <div className="flex min-h-0 shrink flex-col gap-5 md:grid md:grid-cols-2 md:grid-rows-[minmax(0,38vh)_minmax(0,1fr)]">
        {/* A. Follow-ups due (demand loop) —— 常显区块，无数据显示「无」（与「投递计划」口径一致）。 */}
        <Section icon={Bell} title={t("home.followUpsDueTitle")} hint={t("home.followUpsDueHint")} className="flex min-h-0 flex-col md:col-start-1 md:row-start-1">
          {followups.length === 0 ? (
            <p className="text-sm text-muted">无</p>
          ) : (
            <div className="grid min-h-0 flex-1 gap-2.5 overflow-y-auto overscroll-contain hide-scrollbar">
              {followups.map((f) => (
                <FollowUpCard key={`${f.num}-${f.company}`} followup={f} onLogged={() => { setOverdue((n) => Math.max(0, n - 1)); refetch(); }} />
              ))}
            </div>
          )}
        </Section>

        {/* B. Awaiting your decision —— 常显区块，无数据显示「无」；
            落在网格左下，与右下「本周新匹配」同排左右相邻。 */}
        <Section icon={CircleHelp} title={t("home.awaitingTitle")} hint={t("home.awaitingHint")} className="flex min-h-0 flex-col md:col-start-1 md:row-start-2">
          {awaiting.length === 0 ? (
            <p className="text-sm text-muted">无</p>
          ) : (
            <div className="grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto overscroll-contain hide-scrollbar sm:grid-cols-2">
              {awaiting.map((a) => (
                <DecisionCard key={a.n} app={a} />
              ))}
            </div>
          )}
        </Section>

        {/* B2. 投递计划：按 Planned 日期分 今日/明日/未来 子组（遵循用户规则：今明都有都显示，都没有显示「无」）。
            落在网格右上，内容超出时区块内滚动（滚动高度与左列「待跟进」同口径）。 */}
        <Section icon={CalendarDays} title="投递计划" hint={`${plannedCount} 个待投`} className="flex min-h-0 flex-col md:col-start-2 md:row-start-1">
          {plannedCount === 0 ? (
            <p className="text-sm text-muted">无</p>
          ) : (
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto overscroll-contain hide-scrollbar">
              {plannedGroups.today.length > 0 && (
                <PlannedGroup label="今日待投" apps={plannedGroups.today} />
              )}
              {plannedGroups.tomorrow.length > 0 && (
                <PlannedGroup label="明日待投" apps={plannedGroups.tomorrow} />
              )}
              {plannedGroups.later.length > 0 && (
                <PlannedGroup label="未来待投" apps={plannedGroups.later} />
              )}
            </div>
          )}
        </Section>

        {/* C. Fresh matches this week (supply loop) —— 常显区块，无数据显示「无」；
            移到「等待你的决定」右侧（网格右下）。桌面高度由第二行的剩余空间决定，
            窄屏保底一行高度；卡片超出时区块内纵向滚动，列表本身不把页面撑出滚动条。 */}
        <Section
          icon={Sparkles}
          title={t("home.freshMatchesTitle")}
          hint={t("home.freshMatchesHint")}
          className={`flex min-h-0 flex-col md:col-start-2 md:row-start-2 ${visibleFresh.length > 0 ? "max-md:min-h-[235px]" : ""}`}
          action={visibleFresh.length > 12 ? (
            <Link href="/explore?view=fresh" className="inline-flex shrink-0 items-center text-sm text-muted transition hover:text-brand max-sm:min-h-[44px]">
              {t("home.seeAll", { n: newThisWeek })} →
            </Link>
          ) : null}
        >
          {visibleFresh.length === 0 ? (
            <p className="text-sm text-muted">无</p>
          ) : (
            <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto overscroll-contain hide-scrollbar sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
              {visibleFresh.slice(0, 12).map((o) => (
                <DiscoveryCard key={o.url} offer={o} inPipeline={inboxUrls.has(o.url)} />
              ))}
            </div>
          )}
        </Section>
      </div>


      {allClear && (
        <div className="shrink-0 rounded-2xl border border-border bg-surface/30 px-6 py-10 text-center">
          <Sparkles className="mx-auto size-6 text-brand" />
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
             {t("home.nothingNeedsYou1")} <Link href="/explore" className="text-brand hover:underline">{t("home.freeScanLink")}</Link> {t("home.nothingNeedsYou2")} <Link href="/pipeline" className="text-brand hover:underline">{t("nav.pipeline")}</Link>{t("home.nothingNeedsYou3")}
          </p>
        </div>
      )}
    </div>
  );
}

function Section({ icon: Icon, title, hint, children, className, action }: { icon: React.ComponentType<{ className?: string }>; title: string; hint: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    // 区块间距由父容器（首页根 / 两列网格列）的 gap 提供，Section 自身不再带 mt，
    // 以便在「一屏自适应」的网格布局中精确控制纵向空间。
    <section className={className}>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-brand" />
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">{title}</h2>
        <span className="text-xs text-faint">· {hint}</span>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function PlannedGroup({ label, apps }: { label: string; apps: Application[] }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">{label}</p>
      <ol className="grid gap-2.5">
        {apps.map((a, i) => (
          <li key={a.n} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-4 py-3">
            <span className="font-mono text-xs text-muted tabular-nums">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {/* 报告号（tracker# = 报告文件名前缀，与 /report/{n} 同号），与首页决策卡同口径。 */}
                <span className="mr-1.5 font-mono text-xs tabular-nums text-faint">#{a.n}</span>
                {a.company} · {a.role}
              </p>
              <p className="text-xs text-muted">计划 {a.planned}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {a.report && a.report !== "—" && a.report.includes("](") && (
                <Link href={`/report/${a.n}`} className="text-xs text-brand hover:underline">
                  报告 ↗
                </Link>
              )}
              {a.url && (
                <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand hover:underline">
                  职位 ↗
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
