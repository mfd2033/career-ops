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
import { FollowUpCard, type FollowUp } from "@/components/home/follow-up-card";
import { DecisionCard } from "@/components/home/decision-card";
import { QuickEvaluate } from "@/components/quick-evaluate";
import { useI18n } from "@/lib/i18n/context";

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

    // Awaiting decision: scored (Evaluated) but no terminal status yet.
    const awaiting = useMemo(
      () => applications.filter((a) => /^evaluat/i.test(a.status)).slice(0, 6),
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
        .filter((a) => /^evaluat/i.test(a.status) && a.planned && /^\d{4}-\d{2}-\d{2}$/.test(a.planned))
        .sort((a, b) => ((a.planned ?? "") < (b.planned ?? "") ? -1 : (a.planned ?? "") > (b.planned ?? "") ? 1 : 0));
      return {
        today: apps.filter((a) => a.planned === todayStr),
        tomorrow: apps.filter((a) => a.planned === tomorrowStr),
        later: apps.filter((a) => (a.planned ?? "") > tomorrowStr),
      };
    }, [applications]);

  const newThisWeek = freshCount;
  const allClear = newThisWeek === 0 && overdue === 0 && awaiting.length === 0;
  const inboxUrls = useMemo(() => new Set(inbox.map((j) => j.url)), [inbox]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 max-sm:pb-24">
      <section className="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-10 md:px-10 md:py-12">
        <HeroGlow />
        {/* Readability scrim between the animated glow (z-0) and the copy (z-10). */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] bg-surface/55 backdrop-blur-[2px] dark:bg-background/45" />
        <div className="relative z-10">
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
              </>
            )}
          </h1>
          <p className="mt-4 max-w-xl text-sm text-muted">
            {allClear ? t("home.allClearSub") : t("home.actionQueueSub")}
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Link href="/explore" className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 max-sm:min-h-[44px]">
              {t("home.findNewRoles")} <ArrowRight className="size-4" />
            </Link>
            <Link href="/pipeline" className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]">
              {t("home.openPipeline")}
            </Link>
          </div>
          {inBetween && <QuickEvaluate />}
        </div>
      </section>

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

      {/* B. Awaiting your decision */}
      {awaiting.length > 0 && (
        <Section icon={CircleHelp} title={t("home.awaitingTitle")} hint={t("home.awaitingHint")}>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {awaiting.map((a) => (
              <DecisionCard key={a.n} app={a} />
            ))}
          </div>
        </Section>
      )}

      {/* B2. 投递计划：按 Planned 日期分 今日/明日/未来 子组（遵循用户规则：今明都有都显示，都没有显示「无」） */}
      <Section
        icon={CalendarDays}
        title="投递计划"
        hint={`${plannedGroups.today.length + plannedGroups.tomorrow.length + plannedGroups.later.length} 个待投`}
      >
        {plannedGroups.today.length === 0 && plannedGroups.tomorrow.length === 0 && plannedGroups.later.length === 0 ? (
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
      </Section>

      {/* C. Fresh matches this week (supply loop) */}
      {fresh.length > 0 && (
        <Section icon={Sparkles} title={t("home.freshMatchesTitle")} hint={t("home.freshMatchesHint")}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {fresh.slice(0, 6).map((o) => (
              <DiscoveryCard key={o.url} offer={o} inPipeline={inboxUrls.has(o.url)} />
            ))}
          </div>
          {fresh.length > 6 && (
            <Link href="/explore?view=fresh" className="mt-3 inline-flex items-center text-sm text-muted transition hover:text-brand max-sm:min-h-[44px]">
              {t("home.seeAll", { n: freshCount })} →
            </Link>
          )}
        </Section>
      )}

      {allClear && (
        <div className="mt-8 rounded-2xl border border-border bg-surface/30 px-6 py-10 text-center">
          <Sparkles className="mx-auto size-6 text-brand" />
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
             {t("home.nothingNeedsYou1")} <Link href="/explore" className="text-brand hover:underline">{t("home.freeScanLink")}</Link> {t("home.nothingNeedsYou2")} <Link href="/pipeline" className="text-brand hover:underline">{t("nav.pipeline")}</Link>{t("home.nothingNeedsYou3")}
          </p>
        </div>
      )}
    </div>
  );
}

function Section({ icon: Icon, title, hint, children }: { icon: React.ComponentType<{ className?: string }>; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-brand" />
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">{title}</h2>
        <span className="text-xs text-faint">· {hint}</span>
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
              <p className="truncate text-sm font-medium">{a.company} · {a.role}</p>
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
