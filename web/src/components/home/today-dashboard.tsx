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
import { useI18n } from "@/lib/i18n/context";

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
  const [freshCount, setFreshCount] = useState(0);
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
    fetch("/api/whats-new")
      .then((r) => r.json())
      .then((d) => {
        const offers = Array.isArray(d.offers) ? d.offers : [];
        const count = Number(d.count);
        setFresh(offers);
        setFreshCount(Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : offers.length);
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

  const newThisWeek = freshCount;
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
                className="group flex cursor-pointer items-center justify-center rounded-xl border border-border bg-surface/40 p-1.5 transition-colors hover:border-brand/40 hover:bg-surface/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
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

      {/* 主体：桌面（md+）两列网格——左列「待跟进/等待决定」，右列「投递计划」拉伸与
          左列同高（内容超出时区块内滚动）。网格占自身内容高度、空间不足时收缩；
          剩余纵向空间全部让给底部「本周新匹配」。窄屏（<md）回退单列堆叠。 */}
      <div className="flex min-h-0 shrink flex-col gap-5 md:grid md:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-5 md:overflow-y-auto md:overscroll-contain hide-scrollbar">
          {/* A. Follow-ups due (demand loop) */}
          {followups.length > 0 && (
            <Section icon={Bell} title={t("home.followUpsDueTitle")} hint={t("home.followUpsDueHint")}>
              <div className="grid gap-2.5">
                {followups.map((f) => (
                  <FollowUpCard key={`${f.num}-${f.company}`} followup={f} onLogged={() => { setOverdue((n) => Math.max(0, n - 1)); refetch(); }} />
                ))}
              </div>
            </Section>
          )}

          {/* B. Awaiting your decision —— 拉伸占满左列剩余高度，与右列「投递计划」完全等高 */}
          {awaiting.length > 0 && (
            <Section icon={CircleHelp} title={t("home.awaitingTitle")} hint={t("home.awaitingHint")} className="flex min-h-0 flex-1 flex-col">
              <div className="grid gap-2.5 sm:grid-cols-2">
                {awaiting.map((a) => (
                  <DecisionCard key={a.n} app={a} />
                ))}
              </div>
            </Section>
          )}
        </div>

        <div className="flex min-h-0 flex-col gap-5">
          {/* B2. 投递计划：按 Planned 日期分 今日/明日/未来 子组（遵循用户规则：今明都有都显示，都没有显示「无」）。
              区块拉伸占满右列，与左列「等待你的决定」保持同高；内容超出时区块内滚动。 */}
          <Section icon={CalendarDays} title="投递计划" hint={`${plannedCount} 个待投`} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain hide-scrollbar">
              {plannedCount === 0 ? (
                <p className="text-sm text-muted">无</p>
              ) : (
                <div className="grid gap-4">
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
            </div>
          </Section>
        </div>
      </div>

      {/* C. Fresh matches this week (supply loop) — 页面底部，弹性占满两列网格剩下的
          纵向空间：高度富余时 auto-fill 网格自动换行铺多行，高度不足时保底一行、
          区块内纵向滚动，列表本身不把页面撑出滚动条。 */}
      {fresh.length > 0 && (
        <Section
          icon={Sparkles}
          title={t("home.freshMatchesTitle")}
          hint={t("home.freshMatchesHint")}
          className="flex min-h-[235px] flex-1 flex-col"
          action={fresh.length > 12 ? (
            <Link href="/explore?view=fresh" className="inline-flex shrink-0 items-center text-sm text-muted transition hover:text-brand max-sm:min-h-[44px]">
              {t("home.seeAll", { n: freshCount })} →
            </Link>
          ) : null}
        >
          <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto overscroll-contain hide-scrollbar sm:grid-cols-[repeat(auto-fill,minmax(230px,1fr))]">
            {fresh.slice(0, 12).map((o) => (
              <DiscoveryCard key={o.url} offer={o} inPipeline={inboxUrls.has(o.url)} />
            ))}
          </div>
        </Section>
      )}


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
